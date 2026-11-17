import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '@doc/core';
import { evaluationCases, understand } from '../tests/fixtures/understanding.js';

const boundaries = (groups: number[][]) => new Set(groups.slice(1).map((group) => group[0]! - 1));
let truePositive = 0, falsePositive = 0, falseNegative = 0, uncovered = 0, falseMergePairs = 0;
const cases = evaluationCases.map((example) => {
  const result = understand(example.records);
  const groups = result.candidates.map((candidate) => candidate.source_pages);
  const ranges = result.candidates.map((candidate) => candidate.source_locations.map((source) => source.cell_range));
  const groupingCorrect = JSON.stringify(groups) === JSON.stringify(example.groups) && (!example.ranges || JSON.stringify(ranges) === JSON.stringify(example.ranges));
  const pageSources = example.records.filter((record) => record.record_type === 'page' && !['worksheet', 'csv'].includes(record.source_kind));
  if (pageSources.length) {
    const expectedBoundaries = boundaries(example.groups), actualBoundaries = boundaries(groups);
    for (const boundary of actualBoundaries) expectedBoundaries.has(boundary) ? truePositive++ : falsePositive++;
    for (const boundary of expectedBoundaries) if (!actualBoundaries.has(boundary)) falseNegative++;
    for (const page of pageSources) if (!groups.some((group) => group.includes(page.page_number))) uncovered++;
    const goldGroup = new Map(example.groups.flatMap((group, index) => group.map((page) => [page, index] as const)));
    for (const group of groups) for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) {
      if (goldGroup.get(group[left]!) !== goldGroup.get(group[right]!)) falseMergePairs++;
    }
  }
  return { name: example.name, expected_type: example.type, actual_type: result.documentType,
    expected_groups: example.groups, actual_groups: groups, expected_ranges: example.ranges ?? null, actual_ranges: ranges,
    classification_correct: example.type === result.documentType, grouping_correct: groupingCorrect,
    expected_manual_review: example.review, actual_manual_review: result.requiresReview,
    review_correct: example.review === result.requiresReview,
    candidates: result.candidates.map((candidate) => ({ type: candidate.document_type, pages: candidate.source_pages,
      worksheets: candidate.source_worksheets, ranges: candidate.source_locations.map((source) => source.cell_range),
      confidence: candidate.segmentation_confidence, review_reasons: candidate.review_reasons })) };
});
const report = { evaluation: 'segmentation-synthetic-v1', algorithm_version: 'segmentation-v1', measured_at: new Date().toISOString(),
  scope: 'Twelve hand-authored normalized fixtures, covering required scenarios and conservative boundary cases. These templates are also regression fixtures; this is not a held-out or real-document benchmark.',
  confidence_note: 'Segmentation confidence values are deterministic rule scores, not calibrated probabilities.',
  grouping_definition: 'Exact page groups plus exact cell ranges for annotated worksheet cases; PDF boundary scores exclude worksheets.',
  sample_count: cases.length, classification_accuracy: cases.filter((item) => item.classification_correct).length / cases.length,
  exact_grouping_accuracy: cases.filter((item) => item.grouping_correct).length / cases.length,
  review_decision_accuracy: cases.filter((item) => item.review_correct).length / cases.length,
  pdf_boundary_precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null,
  pdf_boundary_recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null,
  false_merge_page_pairs: falseMergePairs, uncovered_pdf_pages: uncovered,
  ai_evaluated: false, ai_note: 'No cloud calls or fabricated model scores. AI governance is verified with controlled providers in tests.', cases };
const directory = join(projectRoot(), 'docs/evaluation');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'segmentation-synthetic.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sample_count: report.sample_count, classification_accuracy: report.classification_accuracy,
  exact_grouping_accuracy: report.exact_grouping_accuracy, false_merge_page_pairs: falseMergePairs, uncovered_pdf_pages: uncovered }));
