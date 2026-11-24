import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildDetailsFileContent,
  ensureKanbanId,
  makeDetailsPreview,
  readKanbanId,
  relativePath,
  stripCopySuffix,
  toNoteFileBaseName,
} from '../detailsFiles';

test('task titles become safe note file names', () => {
  assert.equal(toNoteFileBaseName('週次レポート作成'), '週次レポート作成');
  assert.equal(toNoteFileBaseName('A/B: テスト? #1 [x]|y'), 'A B テスト 1 x y');
  assert.equal(toNoteFileBaseName('  ..hidden. '), 'hidden');
  assert.equal(toNoteFileBaseName('   '), '無題のタスク');
  assert.equal(toNoteFileBaseName('CON'), 'CON_');
  assert.equal(toNoteFileBaseName('あ'.repeat(120)).length, 80);
});

test('collision suffix is stripped', () => {
  assert.equal(stripCopySuffix('会議メモ (2)'), '会議メモ');
  assert.equal(stripCopySuffix('会議メモ'), '会議メモ');
});

test('relative paths between board and notes folders', () => {
  assert.equal(relativePath('/ws/boards', '/ws/boards/project.tasks/a.md'), 'project.tasks/a.md');
  assert.equal(relativePath('/ws/boards', '/ws/notes/done/a.md'), '../notes/done/a.md');
});

test('preview skips front matter and heading', () => {
  const content = '---\ntags: [x]\n---\n\n# タイトル\n\n本文1\n本文2\n';
  assert.equal(makeDetailsPreview(content, 300), '本文1\n本文2');
  assert.equal(makeDetailsPreview('# タイトル\n', 300), '');
  assert.equal(makeDetailsPreview('# T\nabcdef', 3), 'abc…');
});

test('details file content with and without front matter', () => {
  const withFm = buildDetailsFileContent({
    taskId: 'task-1',
    heading: '資料作成',
    tags: ['仕事', 'two words', '2026'],
    boardFileName: 'project.kanban.md',
    created: '2026-11-24',
    frontmatter: true,
  });
  assert.equal(
    withFm,
    '---\nkanban-id: task-1\ntags: [仕事, two-words, "2026"]\ncreated: 2026-11-24\nboard: project.kanban.md\n---\n\n# 資料作成\n'
  );
  assert.equal(
    buildDetailsFileContent({ taskId: 't2', heading: 'X', tags: [], boardFileName: 'b', created: '2026-01-01', frontmatter: false }),
    '# X\n\n<!-- kanban-id: t2 -->\n'
  );
});

test('task id is read from front matter or comment', () => {
  assert.equal(readKanbanId('---\nkanban-id: task-9\ntags: []\n---\n# T\n'), 'task-9');
  assert.equal(readKanbanId('---\nkanban-id: "task-9"\n---\n'), 'task-9');
  assert.equal(readKanbanId('# T\n\n<!-- kanban-id: task-8 -->\n'), 'task-8');
  assert.equal(readKanbanId('# T\nkanban-id: not-front-matter\n'), undefined);
  assert.equal(makeDetailsPreview('# T\n\nメモ\n<!-- kanban-id: task-8 -->\n', 300), 'メモ');
});

test('task id is added only when missing', () => {
  assert.equal(ensureKanbanId('---\ntags: [a]\n---\n# T\n', 't1', true), '---\nkanban-id: t1\ntags: [a]\n---\n# T\n');
  assert.equal(ensureKanbanId('# T\n', 't1', true), '---\nkanban-id: t1\n---\n\n# T\n');
  assert.equal(ensureKanbanId('# T\n\n', 't1', false), '# T\n\n<!-- kanban-id: t1 -->\n');
  const withId = '---\nkanban-id: t0\n---\n';
  assert.equal(ensureKanbanId(withId, 't1', true), withId);
});
