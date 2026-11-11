import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCircuit, encodeCircuit } from './persistence.ts';

test('saved circuit restores parts, positions, board seating, wires and switch state', () => {
  const boards = [{ id: 'b7', x: 120, y: 250 }];
  const parts = [
    { id: 'p2', type: 'source', x: 100, y: 100, resistance: 220, closed: false },
    { id: 'p8', type: 'resistor', x: 260, y: 384, resistance: 330, closed: false,
      seated: { boardId: 'b7', left: '12.a', right: '16.a' } },
    { id: 'p9', type: 'switch', x: 450, y: 100, resistance: 220, closed: true },
  ];
  const wires = [{ id: 'w12', from: { type: 'pin', partId: 'p2', pin: 'a' },
    to: { type: 'hole', boardId: 'b7', hole: '12.e' } }];
  assert.deepEqual(decodeCircuit(encodeCircuit(parts, boards, wires)), {
    parts, boards, wires, nextSequence: 12,
  });
});

test('missing or invalid saved data is ignored', () => {
  assert.equal(decodeCircuit(null), null);
  assert.equal(decodeCircuit('{broken'), null);
  assert.equal(decodeCircuit(JSON.stringify({ version: 2, parts: [], boards: [], wires: [] })), null);
  assert.equal(decodeCircuit(JSON.stringify({ version: 1, parts: [], boards: [], wires: [
    { id: 'w1', from: { type: 'pin', partId: 'p1', pin: 'a' }, to: { type: 'pin', partId: 'p2', pin: 'b' } },
  ] })), null);
});
