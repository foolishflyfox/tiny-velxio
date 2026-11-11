import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNetlist, endpointPoint, findSeat, holeGroup, holePoint } from './circuit.ts';

const part = (id, type, x, y, resistance = 220) => ({ id, type, x, y, resistance });
const pin = (partId, pin) => ({ type: 'pin', partId, pin });
const hole = (boardId, value) => ({ type: 'hole', boardId, hole: value });
const wire = (id, from, to) => ({ id, from, to });

test('direct pin wiring produces a solvable series circuit without a breadboard', () => {
  const parts = [part('p1', 'source', 100, 100), part('p2', 'resistor', 260, 100, 330), part('p3', 'led', 420, 100)];
  const wires = [
    wire('w1', pin('p1', 'a'), pin('p2', 'a')),
    wire('w2', pin('p2', 'b'), pin('p3', 'a')),
    wire('w3', pin('p3', 'b'), pin('p1', 'b')),
  ];
  const deck = buildNetlist(parts, wires);
  assert.match(deck.text, /R_p2 n\d+ n\d+ 330/);
  assert.match(deck.text, /D_p3 p3_internal 0 DRED/);
  assert.equal(deck.ledSenseNames.get('p3'), 'v_p3_sense#branch');
  assert.equal(deck.shortedSource, false);
  assert.deepEqual(endpointPoint(pin('p2', 'b'), parts, []), { x: 320, y: 100 });
});

test('a breadboard joins its five-hole strips and power rails', () => {
  assert.equal(holeGroup('12.a'), holeGroup('12.e'));
  assert.notEqual(holeGroup('12.e'), holeGroup('12.f'));
  assert.equal(holeGroup('tp.1'), holeGroup('tp.50'));
  assert.notEqual(holeGroup('tp.1'), holeGroup('tn.1'));
  assert.ok(holePoint('tp.6').x - holePoint('tp.5').x > holePoint('tp.5').x - holePoint('tp.4').x);
  const board = { id: 'b1', x: 100, y: 200 };
  assert.deepEqual(endpointPoint(hole('b1', '12.c'), [], [board]), { x: 100 + holePoint('12.c').x, y: 200 + holePoint('12.c').y });
  const resistor = part('p2', 'resistor', 100 + holePoint('12.c').x, 200 + holePoint('12.c').y);
  assert.deepEqual(findSeat(resistor, [board], [resistor]), { boardId: 'b1', left: '12.c', right: '16.c' });
});

test('seated pins connect through board groups and board deletion does not affect free wires', () => {
  const source = part('p1', 'source', 100, 100);
  const resistor = { ...part('p2', 'resistor', 260, 100), seated: { boardId: 'b1', left: '12.a', right: '16.a' } };
  const led = part('p3', 'led', 420, 100);
  const wires = [
    wire('w1', pin('p1', 'a'), hole('b1', '12.e')),
    wire('w2', hole('b1', '16.b'), pin('p3', 'a')),
    wire('w3', pin('p3', 'b'), pin('p1', 'b')),
  ];
  const deck = buildNetlist([source, resistor, led], wires);
  assert.match(deck.text, /D_p3 p3_internal 0 DRED/);
  assert.equal(deck.shortedSource, false);
  assert.equal(buildNetlist([source], [wire('short', pin('p1', 'a'), pin('p1', 'b'))]).shortedSource, true);
});

test('a switch keeps its topology and exposes a controllable SPICE source', () => {
  const source = part('p1', 'source', 100, 100);
  const resistor = part('p2', 'resistor', 230, 100, 330);
  const led = part('p3', 'led', 370, 100);
  const switchPart = { ...part('p4', 'switch', 510, 100), closed: false };
  const wires = [
    wire('w1', pin('p1', 'a'), pin('p2', 'a')),
    wire('w2', pin('p2', 'b'), pin('p3', 'a')),
    wire('w3', pin('p3', 'b'), pin('p4', 'a')),
    wire('w4', pin('p4', 'b'), pin('p1', 'b')),
  ];
  const openDeck = buildNetlist([source, resistor, led, switchPart], wires);
  assert.match(openDeck.text, /S_p4 n\d+ 0 p4_ctrl 0 VELXIO_SWITCH/);
  assert.match(openDeck.text, /V_p4_ctrl p4_ctrl 0 DC 0/);
  assert.equal(openDeck.switchControlNames.get('p4'), 'V_p4_ctrl');
  switchPart.closed = true;
  const closedDeck = buildNetlist([source, resistor, led, switchPart], wires);
  assert.match(closedDeck.text, /V_p4_ctrl p4_ctrl 0 DC 5/);
  assert.match(closedDeck.text, /\.model VELXIO_SWITCH SW\(Ron=0\.01 Roff=1G Vt=2\.5 Vh=0\.1\)/);
  assert.equal(closedDeck.shortedSource, false);
});
