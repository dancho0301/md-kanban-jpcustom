import * as path from 'path';
import * as vscode from 'vscode';

const ALLOWED_SOURCE_SCHEMES = new Set(['file', 'vscode-remote', 'vscode-vfs', 'untitled']);

export async function openTaskSource(source: unknown, boardUri: vscode.Uri): Promise<void> {
  if (typeof source !== 'string' || !source.trim()) {
    vscode.window.showInformationMessage('このカードにはソース情報がありません。');
    return;
  }

  const target = resolveSourceLocation(source.trim(), boardUri);
  if (!target) {
    vscode.window.showErrorMessage(`ソース情報を解析できませんでした: ${source}`);
    return;
  }

  try {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const position = new vscode.Position(Math.max(0, target.line - 1), Math.max(0, target.character - 1));
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`ソースを開けませんでした: ${message}`);
  }
}

/**
 * Open a file referenced by a Markdown link in a task description.
 * Unlike source metadata the line number is optional, and relative paths are
 * resolved against the board file first (how Markdown links normally work),
 * then against the workspace root.
 */
export async function openLinkedFile(target: unknown, boardUri: vscode.Uri): Promise<void> {
  if (typeof target !== 'string' || !target.trim()) {
    return;
  }

  const raw = target.trim();
  const lineMatch = raw.match(/^(.*?):(\d+)$/);
  const rawPath = lineMatch ? lineMatch[1] : raw;
  const line = lineMatch ? Number(lineMatch[2]) : 1;

  const uri = await resolveLinkedFileUri(rawPath, boardUri);
  if (!uri) {
    vscode.window.showWarningMessage(`リンク先のファイルが見つかりませんでした: ${raw}`);
    return;
  }

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    const position = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`リンク先を開けませんでした: ${message}`);
  }
}

async function resolveLinkedFileUri(rawPath: string, boardUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (!rawPath) {
    return undefined;
  }

  // Explicit URIs: only allow the document-like schemes we trust.
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) && !/^[a-zA-Z]:[\\/]/.test(rawPath)) {
    const uri = vscode.Uri.parse(rawPath);
    return ALLOWED_SOURCE_SCHEMES.has(uri.scheme.toLowerCase()) ? uri : undefined;
  }

  if (path.isAbsolute(rawPath)) {
    return vscode.Uri.file(rawPath);
  }

  const segments = rawPath.split(/[\\/]/).filter(segment => segment && segment !== '.');
  if (segments.length === 0) {
    return undefined;
  }

  const candidates: vscode.Uri[] = [];
  const boardDir = boardUri.with({ path: boardUri.path.replace(/\/[^/]*$/, '') });
  candidates.push(vscode.Uri.joinPath(boardDir, ...segments));

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(boardUri) ?? vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    candidates.push(vscode.Uri.joinPath(workspaceFolder.uri, ...segments));
  }

  for (const candidate of candidates) {
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function resolveSourceLocation(source: string, boardUri: vscode.Uri): { uri: vscode.Uri; line: number; character: number } | undefined {
  const match = source.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (!match) {
    return undefined;
  }

  const rawPath = match[1].trim();
  const line = Number(match[2]);
  const character = match[3] ? Number(match[3]) : 1;
  if (!rawPath || !Number.isFinite(line) || line < 1 || !Number.isFinite(character) || character < 1) {
    return undefined;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) && !/^[a-zA-Z]:[\\/]/.test(rawPath)) {
    const uri = vscode.Uri.parse(rawPath);
    // Board files can come from untrusted repos; only open document-like schemes.
    if (!ALLOWED_SOURCE_SCHEMES.has(uri.scheme.toLowerCase())) {
      return undefined;
    }
    return { uri, line, character };
  }

  if (path.isAbsolute(rawPath)) {
    return { uri: vscode.Uri.file(rawPath), line, character };
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(boardUri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  return {
    uri: vscode.Uri.joinPath(workspaceFolder.uri, ...rawPath.split(/[\\/]/).filter(Boolean)),
    line,
    character,
  };
}
