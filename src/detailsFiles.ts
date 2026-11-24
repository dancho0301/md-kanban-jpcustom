/**
 * Pure helpers for per-task details files (no VS Code API, so they can be
 * unit tested). Files are named after their task like Foam notes.
 */

/**
 * Key that ties a details file to its task. The board stores the file's path,
 * but the id lets a file be found again after it was renamed or moved outside
 * the extension (e.g. while organizing notes in Foam).
 */
export const KANBAN_ID_KEY = 'kanban-id';

/** A task title turned into a safe, Foam-friendly file name (without extension). */
export function toNoteFileBaseName(title: string): string {
  let name = String(title)
    // Path separators, characters Windows forbids, and characters that break
    // Foam wikilinks ([[name#section|alias]], ^block refs).
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .replace(/[. ]+$/, '')
    .trim();
  if (!name) {
    name = '無題のタスク';
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) {
    name += '_';
  }
  return name;
}

/** "Name (2)" -> "Name": the suffix added when a name is already taken. */
export function stripCopySuffix(baseName: string): string {
  return baseName.replace(/ \(\d+\)$/, '');
}

/** POSIX path of `targetPath` relative to the directory `baseDirPath`. */
export function relativePath(baseDirPath: string, targetPath: string): string {
  const from = baseDirPath.split('/').filter(Boolean);
  const to = targetPath.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common++;
  }
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}

/** Body text below the front matter and first heading, shortened for a tooltip. */
export function makeDetailsPreview(content: string, maxChars: number): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end !== -1) {
      start = end + 1;
    }
  }
  while (start < lines.length && !lines[start].trim()) {
    start++;
  }
  if (start < lines.length && /^#\s/.test(lines[start])) {
    start++;
  }
  const body = lines
    .slice(start)
    .filter(line => !KANBAN_ID_COMMENT.test(line))
    .join('\n')
    .trim();
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
}

export interface DetailsFileContentOptions {
  taskId: string;
  heading: string;
  tags: unknown;
  boardFileName: string;
  /** YYYY-MM-DD */
  created: string;
  frontmatter: boolean;
}

/** Initial content of a details file: optional Foam-style front matter and a heading. */
export function buildDetailsFileContent(options: DetailsFileContentOptions): string {
  if (!options.frontmatter) {
    return `# ${options.heading}\n\n<!-- ${KANBAN_ID_KEY}: ${options.taskId} -->\n`;
  }
  // Foam tags cannot contain spaces.
  const tags = Array.isArray(options.tags)
    ? options.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map(tag => tag.trim().replace(/^#/, '').replace(/\s+/g, '-'))
        .filter(Boolean)
    : [];
  return [
    '---',
    `${KANBAN_ID_KEY}: ${options.taskId}`,
    `tags: [${tags.map(yamlString).join(', ')}]`,
    `created: ${options.created}`,
    `board: ${yamlString(options.boardFileName)}`,
    '---',
    '',
    `# ${options.heading}`,
    '',
  ].join('\n');
}

function yamlString(value: string): string {
  return /^[\p{L}\p{N}_.\-/]+$/u.test(value) && !/^[\d.-]/.test(value) ? value : JSON.stringify(value);
}

const KANBAN_ID_COMMENT = /^\s*<!--\s*kanban-id:\s*\S+\s*-->\s*$/;

/** Task id recorded in a details file (front matter or `<!-- kanban-id: -->`). */
export function readKanbanId(content: string): string | undefined {
  const text = content.replace(/\r\n?/g, '\n');
  const frontMatter = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (frontMatter) {
    const line = frontMatter[1].match(/^kanban-id:\s*["']?([^"'\s]+)["']?\s*$/m);
    if (line) {
      return line[1];
    }
  }
  const comment = text.match(/<!--\s*kanban-id:\s*(\S+)\s*-->/);
  return comment ? comment[1] : undefined;
}

/**
 * Add the task id to an existing details file that has none: into its front
 * matter when it has one (or when front matter is preferred), otherwise as a
 * trailing comment. Returns the content unchanged when an id is present.
 */
export function ensureKanbanId(content: string, taskId: string, preferFrontmatter: boolean): string {
  if (readKanbanId(content) !== undefined) {
    return content;
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  if (/^---\r?\n/.test(content)) {
    return content.replace(/^---\r?\n/, `---${newline}${KANBAN_ID_KEY}: ${taskId}${newline}`);
  }
  if (preferFrontmatter) {
    return `---${newline}${KANBAN_ID_KEY}: ${taskId}${newline}---${newline}${newline}${content}`;
  }
  const trimmed = content.replace(/\s+$/, '');
  return `${trimmed}${newline}${newline}<!-- ${KANBAN_ID_KEY}: ${taskId} -->${newline}`;
}
