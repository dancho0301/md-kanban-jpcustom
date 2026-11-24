import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildDetailsFileContent,
  makeDetailsPreview,
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
    heading: '資料作成',
    tags: ['仕事', 'two words', '2026'],
    boardFileName: 'project.kanban.md',
    created: '2026-11-24',
    frontmatter: true,
  });
  assert.equal(
    withFm,
    '---\ntags: [仕事, two-words, "2026"]\ncreated: 2026-11-24\nboard: project.kanban.md\n---\n\n# 資料作成\n'
  );
  assert.equal(
    buildDetailsFileContent({ heading: 'X', tags: [], boardFileName: 'b', created: '2026-01-01', frontmatter: false }),
    '# X\n'
  );
});
