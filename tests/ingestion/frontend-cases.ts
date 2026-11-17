import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { projectRoot, type RuntimeEnvironment } from '@doc/core';
import { buildApi } from '../../apps/api/src/app.js';
import { buildWorker } from '../../apps/worker/src/app.js';
import { mockProvider } from '../fixtures/extraction.js';
import { browserEmbedding } from './workspace-cases.js';
import type { WorkspaceResources } from './workspace-cases.js';
async function port() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string')
    throw new Error('No test port'); await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export function registerFrontendTests(resources: () => WorkspaceResources) {
  describe('real Next.js browser workflows', { concurrency: false }, () => {
    let r: WorkspaceResources, api: ReturnType<typeof buildApi>, worker: ReturnType<typeof buildWorker>, web: ReturnType<typeof spawn>, browser: Browser, context: BrowserContext, page: Page, base: string, first: string, second: string, spreadsheet: string;
    const browserErrors: string[] = [];
    let output = '';
    let apiEnvironment: RuntimeEnvironment;
    async function openWorkspace(target: Page) { await target.goto(base + '/'); await target.locator('.metric-card strong').first().waitFor(); await target.waitForFunction(() => !document.querySelector('.metric-skeleton')); }
    async function upload(name: string) { await page.goto(base + '/upload'); await page.getByLabel('Choose documents').setInputFiles(join(r.fixtures, name)); const response = page.waitForResponse(response => response.url().endsWith('/api/backend/documents') && response.request().method() === 'POST'); await page.getByRole('button', { name: /Upload 1 file/ }).click(); const received = await response; assert.equal(received.status(), 202); const result = await received.json(); await page.getByText('Batch accepted. Follow live document status below.').waitFor(); return result.documents[0].id as string; }
    async function processed(id: string) { await r.waitFor(async () => !!(await r.query("SELECT id FROM public.documents WHERE id=$1 AND metadata#>>'{search,generation}'=search_generation::text", [id])).rowCount); }
    before(async () => {
      r = resources();
      const apiPort = await port(), webPort = await port(), env = { ...r.environment, API_PORT: apiPort, WEB_PORT: webPort, WORKFLOW_ENABLED: true, LOCAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_LLM_MODEL: 'qwen-fixture-instruct', LLM_MAX_ATTEMPTS: 1 };
      apiEnvironment = env;
      api = buildApi(env, { embeddingClient: browserEmbedding });
      await api.listen({ host: '127.0.0.1', port: apiPort });
      worker = buildWorker(env, { embeddingClient: browserEmbedding, extractionProviders: { gemini: null, local: mockProvider('local_qwen') }, extractionWait: async () => { } });
      await worker.app.ready();
      const require = createRequire(import.meta.url);
      web = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], { cwd: join(projectRoot(), 'apps/web'), env: { ...process.env, ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = (data: Buffer) => { output = (output + data.toString()).slice(-4000); };
      web.stdout?.on('data', collect);
      web.stderr?.on('data', collect);
      base = 'http://localhost:' + webPort;
      await r.waitFor(async () => {
        if (web.exitCode !== null)
          throw new Error('Isolated web server exited: ' + output); try {
            return (await fetch(base + '/api/health')).ok;
          }
        catch {
          return false;
        }
      });
      browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update'] });
      context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
      page = await context.newPage();
      page.on('pageerror', error => browserErrors.push(error.message));
      await mkdir(join(projectRoot(), '.cache/frontend'), { recursive: true });
    });
    after(async () => {
      await browser?.close(); if (web && web.exitCode === null) {
        const stopped = new Promise<void>(resolve => web.once('exit', () => resolve()));
        web.kill('SIGTERM');
        await stopped;
      } await worker?.app.close(); await api?.close();
    });
    it('opens pages directly and rejects cross-origin writes', async () => {
      await page.goto(base + '/documents');
      assert.equal(new URL(page.url()).pathname, '/documents');
      assert.equal((await context.request.get(base + '/api/backend/dashboard')).status(), 200);
      assert.equal((await context.request.post(base + '/api/backend/documents', { headers: { origin: 'https://untrusted.invalid' }, data: {} })).status(), 403);
      assert.equal((await context.request.get(base + '/api/backend/unknown')).status(), 404);
    });
    it('opens the workspace without credentials or session cookies', async () => {
      await openWorkspace(page);
      assert.equal((await context.cookies()).length, 0);
      assert.equal(await page.getByRole('button', { name: 'Sign out' }).count(), 0);
      assert.equal((await context.request.post(base + '/api/session')).status(), 404);
      assert.equal(await page.evaluate(() => localStorage.length), 0);
      const actual = (await (await context.request.get(base + '/api/backend/dashboard')).json()).counts.total;
      assert.equal(await page.locator('.metric-card').filter({ hasText: 'Total documents' }).locator('strong').innerText(), String(actual));
      await page.screenshot({ path: join(projectRoot(), '.cache/frontend/dashboard-desktop.png'), fullPage: true });
    });
    it('validates files locally, uploads multiple real files and tracks accepted batches', async () => {
      await page.goto(base + '/upload');
      await page.getByLabel('Choose documents').setInputFiles({ name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
      await page.getByText('unsupported.exe: unsupported file extension.').waitFor();
      await page.getByRole('button', { name: 'Remove unsupported.exe' }).click();
      await page.getByLabel('Choose documents').setInputFiles([join(r.fixtures, 'ai-invoice.pdf'), join(r.fixtures, 'ai-ledger.xlsx')]);
      const response = page.waitForResponse(response => response.url().endsWith('/api/backend/documents') && response.request().method() === 'POST');
      await page.getByRole('button', { name: /Upload 2 file/ }).click();
      const received = await response;
      assert.equal(received.status(), 202);
      const docs = (await received.json()).documents;
      first = docs.find((doc: {
        originalFilename: string;
      }) => doc.originalFilename.endsWith('.pdf')).id;
      spreadsheet = docs.find((doc: {
        originalFilename: string;
      }) => doc.originalFilename.endsWith('.xlsx')).id;
      await page.getByText('Batch accepted. Follow live document status below.').waitFor();
      await processed(first);
      await processed(spreadsheet);
    });
    it('updates source evidence when a document is opened before processing completes',async()=>{
      await worker.documents.pause();let id:string;
      try{id=await upload('ai-invoice.pdf');await page.goto(base+'/documents/'+id);await page.getByText('Source text and OCR details appear when processing completes.').waitFor();}
      finally{await worker.documents.resume();}
      await processed(id!);await page.locator('.source-metadata strong').waitFor();assert.ok((await page.locator('.source-metadata').innerText()).includes('Digital'));
    });
    it('loads and filters actual document rows and provides pagination', async () => {
      await page.goto(base + '/documents');
      await page.getByPlaceholder('Find a filename…').fill('ai-invoice');
      await page.locator('tbody tr').first().waitFor();
      assert.ok((await page.locator('tbody').innerText()).includes('ai-invoice.pdf'));
      await page.getByPlaceholder('Find a filename…').fill('absent-frontend-file-0d4');
      await page.getByRole('heading', { name: 'No documents found' }).waitFor();
      await page.getByPlaceholder('Find a filename…').fill('');
      await page.locator('tbody tr').first().waitFor();
      await page.getByRole('button', { name: /Next page/ }).click();
      await page.getByRole('button', { name: 'Previous', exact: true }).click();
      await page.waitForFunction(()=>{const button=document.querySelector<HTMLButtonElement>('.pager button');return !!button&&button.disabled;});
      assert.equal(await page.getByRole('button', { name: 'Previous', exact: true }).isDisabled(), true);
    });
    it('shows the original PNG preview, extracted fields, model and source evidence', async () => {
      await page.goto(base + '/documents/' + first);
      await page.getByRole('tab', { name: 'Extracted data' }).waitFor();
      await page.waitForFunction(() => { const img = document.querySelector('.source-canvas img') as HTMLImageElement | null; return !!img?.complete && img.naturalWidth > 0; });
      await page.locator('.invoice-fields').getByText('INV-101', { exact: true }).waitFor();
      assert.ok((await page.locator('.extraction-panel .panel-heading').innerText()).includes('Local Qwen'));
      await page.getByRole('button', { name: 'Source', exact: true }).first().click();
      await page.getByText('Supporting evidence', { exact: true }).waitFor();
      assert.ok((await page.locator('.source-metadata').innerText()).includes('Digital'));
      await page.screenshot({ path: join(projectRoot(), '.cache/frontend/document-details.png'), fullPage: true });
    });
    it('saves real corrections, preserves originals and shows attributable audit history', async () => {
      await page.getByRole('tab', { name: 'Manual review', exact: true }).click();
      await page.getByLabel('Total', { exact: true }).fill('120.00');
      await page.getByLabel('Correction reason').fill('Verified against the browser test source');
      await page.getByRole('button', { name: 'Save corrections' }).click();
      await page.getByText('Correction saved. Follow-up validation and indexing run in the background.').waitFor();
      await processed(first);
      await page.getByRole('tab', { name: 'Audit history' }).click();
      await page.getByText('Verified against the browser test source', { exact: true }).waitFor();
      await page.getByText('Original and changed values', { exact: true }).first().click();
      assert.ok((await page.locator('.audit-list').innerText()).includes('120'));
      assert.ok((await page.locator('.audit-list').innerText()).includes('Actor:'));
    });
    it('canceling an edit never reports a correction was saved', async () => {
      await page.reload();
      await page.getByRole('tab', { name: 'Manual review' }).click();
      await page.getByLabel('Customer', { exact: true }).fill('Unsaved browser value');
      await page.getByRole('button', { name: 'Cancel / reload' }).click();
      await page.waitForFunction(() => { const field = document.querySelector<HTMLInputElement>('input[aria-label="Customer"]'); return !!field && field.value !== 'Unsaved browser value'; });
      assert.notEqual(await page.getByLabel('Customer', { exact: true }).inputValue(), 'Unsaved browser value');
      assert.equal(await page.getByText('Correction saved. Follow-up validation and indexing run in the background.').count(), 0);
    });
    it('loads the actual manual review queue and invoice-field search results', async () => {
      await page.goto(base + '/reviews');
      await page.locator('tbody tr').first().waitFor();
      await page.getByRole('link', { name: /Open review/ }).first().click();
      await page.waitForURL(/\/documents\//);
      assert.match(new URL(page.url()).pathname, /^\/documents\//);
      await page.goto(base + '/search');
      await page.getByRole('tab', { name: 'Invoice fields' }).click();
      await page.getByLabel('Invoice number', { exact: true }).fill('INV-101');
      await page.getByLabel('Currency', { exact: true }).fill('USD');
      await page.getByLabel('Minimum total').fill('120');
      await page.getByLabel('Maximum total').fill('120');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('heading', { name: 'Search results', exact: true }).waitFor();
      assert.ok(await page.locator('.search-result').count());
    });
    it('compares actual PDFs and highlights real discrepancies', async () => {
      second = await upload('ai-invoice.pdf');
      await processed(second);
      await page.goto(base + '/reconciliation');
      await page.getByLabel('Left source document', { exact: true }).selectOption(first);
      await page.getByLabel('Right source document', { exact: true }).selectOption(second);
      await page.getByRole('button', { name: 'Compare documents' }).click();
      await page.getByRole('heading', { name: 'Comparison result', exact: true }).waitFor();
      assert.ok(await page.locator('.comparison-table .discrepancy').count());
      assert.ok((await page.locator('.comparison-result').innerText()).includes('120'));
      await page.screenshot({ path: join(projectRoot(), '.cache/frontend/reconciliation.png'), fullPage: true });
    });
    it('compares PDF and spreadsheet sources and previews actual worksheet cells', async () => {
      await page.getByLabel('Left source document', { exact: true }).selectOption(second);
      await page.getByLabel('Right source document', { exact: true }).selectOption(spreadsheet);
      await page.getByRole('button', { name: 'Compare documents' }).click();
      await page.getByRole('heading', { name: 'Comparison result', exact: true }).waitFor();
      assert.ok(await page.locator('.comparison-table tbody tr').count());
      await page.goto(base + '/documents/' + spreadsheet);
      await page.locator('.spreadsheet-preview tbody tr').first().waitFor();
      assert.ok((await page.locator('.spreadsheet-preview').innerText()).includes('INV-101'));
    });
    it('renders responsive mobile screens without horizontal page overflow', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const path of ['/', '/documents', '/upload', '/reviews', '/search', '/reconciliation', '/documents/' + first]) {
        await page.goto(base + path);
        await page.locator('h1').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, path);
      }
      await page.goto(base + '/');
      await page.waitForFunction(() => !document.querySelector('.metric-skeleton'));
      await page.screenshot({ path: join(projectRoot(), '.cache/frontend/dashboard-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1512, height: 982 });
    });
    it('deletes a document via confirmation dialog and removes it from workspace queries', async () => {
      const targetId = await upload('ai-invoice.pdf');
      await processed(targetId);
      const beforeCount = (await (await context.request.get(base + '/api/backend/dashboard')).json()).counts.total;
      await page.goto(base + '/documents/' + targetId);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('button', { name: 'Delete document', exact: true }).click();
      await page.waitForURL(/\/documents$/);
      assert.equal((await context.request.get(base + '/api/backend/documents/' + targetId)).status(), 404);
      const afterCount = (await (await context.request.get(base + '/api/backend/dashboard')).json()).counts.total;
      assert.equal(afterCount, beforeCount - 1);
    });
    it('shows request errors and respects the configured read-only operator', async () => {
      await page.route('**/api/backend/dashboard', route => route.abort());
      await page.goto(base + '/');
      await page.locator('.notice[role=alert]').waitFor();
      await page.unroute('**/api/backend/dashboard');
      await page.getByRole('button', { name: 'Try again' }).click();
      await page.waitForFunction(() => !document.querySelector('.metric-skeleton'));
      await api.close();
      api = buildApi({ ...apiEnvironment, LOCAL_WORKSPACE_USER_ID: r.readerWorkspace.split(':')[1]! }, { embeddingClient: browserEmbedding });
      await api.listen({ host: '127.0.0.1', port: apiEnvironment.API_PORT });
      const readonly = await browser.newContext(), reader = await readonly.newPage();
      await openWorkspace(reader);
      await reader.goto(base + '/upload');
      assert.equal(await reader.getByRole('button', { name: 'Browse files' }).isDisabled(), true);
      await reader.goto(base + '/documents/' + first + '?review=any');
      await reader.getByRole('button', { name: 'Save corrections' }).waitFor();
      assert.equal(await reader.getByRole('button', { name: 'Save corrections' }).isDisabled(), true);
      assert.equal(await reader.getByRole('button', { name: 'Delete', exact: true }).count(), 0);
      assert.equal((await readonly.request.delete(base + '/api/backend/documents/' + first, { headers: { origin: base } })).status(), 403);
      await readonly.close();
      assert.deepEqual(browserErrors, []);
    });
  });
}
