import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadEnvironment, projectRoot } from '@doc/core';
import { createMigrationPool } from '@doc/database/admin';
export function retrievalMetrics(ranked: string[], relevance: Record<string, number>) {
  const ids = [...new Set(ranked)], relevant = Object.keys(relevance).filter(id => relevance[id]! > 0);
  if (!relevant.length)
    throw new Error('Each benchmark query needs positive relevance labels');
  const recall = (k: number) => ids.slice(0, k).filter(id => (relevance[id] ?? 0) > 0).length / relevant.length;
  const first = ids.slice(0, 10).findIndex(id => (relevance[id] ?? 0) > 0);
  const dcg = (grades: number[]) => grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const ideal = dcg(Object.values(relevance).filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10));
  return { recall_at_5: recall(5), recall_at_10: recall(10), mrr_at_10: first < 0 ? 0 : 1 / (first + 1), ndcg_at_10: ideal ? dcg(ids.slice(0, 10).map(id => relevance[id] ?? 0)) / ideal : 0 };
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function latency(values: number[]) { const ordered = [...values].sort((a, b) => a - b); return { mean_ms: mean(values), p50_ms: ordered[Math.floor((ordered.length - 1) * 0.5)], p95_ms: ordered[Math.ceil((ordered.length - 1) * 0.95)] }; }
async function run() {
  const env = loadEnvironment(), root = projectRoot(), directory = await mkdtemp(join(tmpdir(), 'di-embedding-benchmark-')), pool = createMigrationPool(env);
  const interpreter = process.env.PYTHON_EXECUTABLE;
  if (!interpreter)
    throw new Error('Existing PYTHON_EXECUTABLE is required');
  const selected = process.argv.includes('--harrier-only') ? ['harrier'] : process.argv.includes('--qwen-only') ? ['qwen'] : ['qwen', 'harrier'];
  const results = [];
  let chunkHash: string | undefined, datasetHash: string | undefined;
  const client = await pool.connect();
  try {
    await client.query('CREATE TEMP TABLE embedding_benchmark (id text PRIMARY KEY,document_id text NOT NULL,embedding vector(1024) NOT NULL)');
    await client.query('CREATE INDEX embedding_benchmark_hnsw ON embedding_benchmark USING hnsw(embedding vector_cosine_ops)');
    await client.query('SET enable_seqscan=off');
    for (const model of selected) {
      const file = join(directory, model + '.json');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(interpreter, [join(root, 'services/document-processor/tests/benchmark_embeddings.py'), '--model', model, '--dataset', join(root, 'tests/fixtures/retrieval-synthetic.json'), '--output', file], { env: { ...process.env, PYTHONPATH: join(root, 'services/document-processor/src'), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', EMBEDDING_CPU_THREADS: '4', PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('Local benchmark failed for ' + model)));
      });
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (chunkHash && data.chunks_sha256 !== chunkHash)
        throw new Error('Benchmark chunks differ between models');
      chunkHash = data.chunks_sha256;
      if (datasetHash && data.dataset_sha256 !== datasetHash)
        throw new Error('Benchmark dataset changed between models');
      datasetHash = data.dataset_sha256;
      await client.query('TRUNCATE embedding_benchmark');
      for (const row of data.rows)
        await client.query('INSERT INTO embedding_benchmark VALUES ($1,$2,$3::vector)', [row.id, row.document_id, JSON.stringify(row.vector)]);
      const samples: number[] = [], perQuery: ({
        id: string;
      } & ReturnType<typeof retrievalMetrics>)[] = [];
      for (const query of data.queries) {
        const sql = 'SELECT document_id FROM embedding_benchmark ORDER BY embedding <=> $1::vector LIMIT 100';
        await client.query(sql, [JSON.stringify(query.vector)]);
        const start = performance.now(), ranked = await client.query(sql, [JSON.stringify(query.vector)]);
        samples.push(performance.now() - start);
        perQuery.push({ id: query.id, ...retrievalMetrics(ranked.rows.map(row => row.document_id), query.relevance) });
      }
      const plan = (await client.query('EXPLAIN (FORMAT JSON) SELECT id FROM embedding_benchmark ORDER BY embedding <=> $1::vector LIMIT 10', [JSON.stringify(data.queries[0].vector)])).rows[0];
      const { rows, queries, ...metadata } = data;
      const averages = Object.fromEntries(['recall_at_5', 'recall_at_10', 'mrr_at_10', 'ndcg_at_10'].map(key => [key, mean(perQuery.map(row => (row as Record<string, any>)[key]))]));
      results.push({
        ...metadata, corpus_documents: data.corpus_documents, chunks: rows.length, queries: queries.length, metrics: averages, query_results: perQuery,
        embedding_latency: { document_batches: latency(data.document_batch_ms), queries: latency(data.query_embedding_ms) }, search_latency: latency(samples), postgres_plan: plan
      });
      console.log(JSON.stringify({ model: data.model_id, ...averages, search_latency: latency(samples) }));
    }
    const report = { dataset: 'synthetic English/Bengali business invoices; 30 documents, 16 manually labeled queries', scope: 'Local CPU inference and isolated PostgreSQL pgvector HNSW retrieval, not real-document accuracy', created_at: new Date().toISOString(), results };
    const output = join(root, 'docs/evaluation/embeddings-' + (selected.length === 2 ? 'comparison' : selected[0]) + '.json');
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Wrote ' + output);
  }
  finally {
    client.release();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1]?.endsWith('benchmark-embeddings.ts'))
  await run();
