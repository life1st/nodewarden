import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFolderTree, flattenFolderTree } from '../webapp/src/lib/folder-tree';
import type { Folder } from '../webapp/src/lib/types';

function createFolder(id: string, name: string): Folder {
  return {
    id,
    name,
    decName: name,
    revisionDate: '2026-01-01T00:00:00.000Z',
  };
}

test('buildFolderTree creates hierarchy when parent folder exists', () => {
  const folders: Folder[] = [
    createFolder('1', 'Work'),
    createFolder('2', 'Work/Email'),
    createFolder('3', 'Work/Email/Personal'),
    createFolder('4', 'Personal'),
  ];

  const tree = buildFolderTree(folders);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].label, 'Work');
  assert.equal(tree[0].folder.id, '1');
  assert.equal(tree[0].children.length, 1);

  const subfolder = tree[0].children[0];
  assert.equal(subfolder.label, 'Email');
  assert.equal(subfolder.folder.id, '2');
  assert.equal(subfolder.children.length, 1);

  const leaf = subfolder.children[0];
  assert.equal(leaf.label, 'Personal');
  assert.equal(leaf.folder.id, '3');
  assert.equal(leaf.children.length, 0);

  assert.equal(tree[1].label, 'Personal');
  assert.equal(tree[1].folder.id, '4');
  assert.equal(tree[1].children.length, 0);
});

test('buildFolderTree keeps paths as roots when parent folder does not exist', () => {
  const folders: Folder[] = [
    createFolder('1', 'Work/Email'),
  ];

  const tree = buildFolderTree(folders);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].label, 'Work/Email');
  assert.equal(tree[0].children.length, 0);
});

test('flattenFolderTree flattens tree in DFS order with correct depths', () => {
  const folders: Folder[] = [
    createFolder('1', 'Work'),
    createFolder('2', 'Work/Email'),
    createFolder('3', 'Personal'),
  ];

  const tree = buildFolderTree(folders);
  const rows = flattenFolderTree(tree, new Set());

  assert.equal(rows.length, 3);
  assert.equal(rows[0].folder.id, '1');
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[0].label, 'Work');

  assert.equal(rows[1].folder.id, '2');
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[1].label, 'Email');

  assert.equal(rows[2].folder.id, '3');
  assert.equal(rows[2].depth, 0);
  assert.equal(rows[2].label, 'Personal');
});

test('flattenFolderTree hides descendants when folder is collapsed', () => {
  const folders: Folder[] = [
    createFolder('1', 'Work'),
    createFolder('2', 'Work/Email'),
    createFolder('3', 'Personal'),
  ];

  const tree = buildFolderTree(folders);
  const collapsed = new Set(['1']);
  const rows = flattenFolderTree(tree, collapsed);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].folder.id, '1');
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[1].folder.id, '3');
  assert.equal(rows[1].depth, 0);
});
