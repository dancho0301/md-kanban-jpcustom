/**
 * Pure helpers for per-task details files (no VS Code API, so they can be
 * unit tested). Files are named after their task like Foam notes.
 */

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
  const body = lines.slice(start).join('\n').trim();
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
}

export interface DetailsFileContentOptions {
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
    return `# ${options.heading}\n`;
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
