export type PartType = 'source' | 'led' | 'resistor' | 'switch';
export type Row = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j';
export type Rail = 'tp' | 'tn' | 'bp' | 'bn';
export type Hole = `${number}.${Row}` | `${Rail}.${number}`;

export interface Board { id: string; x: number; y: number }
export interface Part {
  id: string;
  type: PartType;
  x: number;
  y: number;
  resistance: number;
  closed?: boolean;
  seated?: { boardId: string; left: Hole; right: Hole };
}
export type Endpoint =
  | { type: 'pin'; partId: string; pin: 'a' | 'b' }
  | { type: 'hole'; boardId: string; hole: Hole };
export interface Wire { id: string; from: Endpoint; to: Endpoint }

export const COLS = 63;
export const PITCH = 15;
export const X0 = 80;
export const BOARD_WIDTH = 1100;
export const BOARD_HEIGHT = 445;
export const CANVAS_WIDTH = 1500;
export const CANVAS_HEIGHT = 1000;
export const LED_BURN_CURRENT = 0.02;
export function ledShouldBurn(forwardCurrent: number): boolean {
  return forwardCurrent > LED_BURN_CURRENT;
}
export const ROWS: readonly Row[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
export const ROW_Y: Record<Row, number> = { a: 134, b: 152, c: 170, d: 188, e: 206, f: 246, g: 264, h: 282, i: 300, j: 318 };
export const RAIL_Y: Record<Rail, number> = { tn: 59, tp: 79, bn: 367, bp: 387 };
export const RAILS: readonly Rail[] = ['tn', 'tp', 'bn', 'bp'];

export function holePoint(hole: Hole): { x: number; y: number } {
  const [first, second] = hole.split('.');
  if (first in RAIL_Y) {
    const index = Number(second) - 1;
    return { x: X0 + 20 + (index + Math.floor(index / 5)) * PITCH, y: RAIL_Y[first as Rail] };
  }
  return { x: X0 + (Number(first) - 1) * PITCH, y: ROW_Y[second as Row] };
}

export function holeGroup(hole: Hole): string {
  const [first, second] = hole.split('.');
  if (first in RAIL_Y) return first;
  return `${first}${'abcde'.includes(second) ? 't' : 'b'}`;
}

export function endpointKey(endpoint: Endpoint): string {
  return endpoint.type === 'pin'
    ? `${endpoint.partId}:${endpoint.pin}`
    : `${endpoint.boardId}:${holeGroup(endpoint.hole)}`;
}

export function endpointPoint(endpoint: Endpoint, parts: readonly Part[], boards: readonly Board[]): { x: number; y: number } | null {
  if (endpoint.type === 'pin') {
    const part = parts.find((candidate) => candidate.id === endpoint.partId);
    return part ? { x: part.x + (endpoint.pin === 'b' ? 60 : 0), y: part.y } : null;
  }
  const board = boards.find((candidate) => candidate.id === endpoint.boardId);
  if (!board) return null;
  const point = holePoint(endpoint.hole);
  return { x: board.x + point.x, y: board.y + point.y };
}

/** Snap a two-pin part onto two holes four columns apart when it is dropped near a strip row. */
export function findSeat(part: Part, boards: readonly Board[], otherParts: readonly Part[]): Part['seated'] | undefined {
  for (const board of boards) {
    const localX = part.x - board.x;
    const localY = part.y - board.y;
    const row = ROWS.reduce((best, next) => Math.abs(ROW_Y[next] - localY) < Math.abs(ROW_Y[best] - localY) ? next : best);
    const col = Math.round((localX - X0) / PITCH) + 1;
    if (Math.abs(ROW_Y[row] - localY) > 12 || col < 1 || col > COLS - 4) continue;
    if (Math.abs(X0 + (col - 1) * PITCH - localX) > 10) continue;
    const left: Hole = `${col}.${row}`;
    const right: Hole = `${col + 4}.${row}`;
    const blocked = otherParts.some((other) => other.id !== part.id && other.seated?.boardId === board.id &&
      ([other.seated.left, other.seated.right].includes(left) || [other.seated.left, other.seated.right].includes(right)));
    if (!blocked) return { boardId: board.id, left, right };
  }
  return undefined;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key);
    const parent = this.parent.get(key)!;
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }
  join(a: string, b: string): void { this.parent.set(this.find(a), this.find(b)); }
}

export interface Netlist {
  text: string;
  ledSenseNames: Map<string, string>;
  ledFailureControlNames: Map<string, string>;
  sourceCurrentNames: string[];
  switchControlNames: Map<string, string>;
  shortedSource: boolean;
}

/** Build an ngspice deck from direct pin wires, breadboard groups and seated pins. */
export function buildNetlist(parts: readonly Part[], wires: readonly Wire[]): Netlist {
  const uf = new UnionFind();
  for (const wire of wires) uf.join(endpointKey(wire.from), endpointKey(wire.to));
  for (const part of parts) {
    if (!part.seated) continue;
    uf.join(`${part.id}:a`, `${part.seated.boardId}:${holeGroup(part.seated.left)}`);
    uf.join(`${part.id}:b`, `${part.seated.boardId}:${holeGroup(part.seated.right)}`);
  }
  const firstSource = parts.find((part) => part.type === 'source');
  const ground = firstSource ? uf.find(`${firstSource.id}:b`) : null;
  const names = new Map<string, string>();
  let nextNode = 1;
  function net(partId: string, pin: 'a' | 'b'): string {
    const root = uf.find(`${partId}:${pin}`);
    if (root === ground) return '0';
    if (!names.has(root)) names.set(root, `n${nextNode++}`);
    return names.get(root)!;
  }

  const cards: string[] = ['Tiny Velxio circuit'];
  const ledSenseNames = new Map<string, string>();
  const ledFailureControlNames = new Map<string, string>();
  const sourceCurrentNames: string[] = [];
  const switchControlNames = new Map<string, string>();
  let shortedSource = false;
  for (const part of parts) {
    const a = net(part.id, 'a');
    const b = net(part.id, 'b');
    if (part.type === 'source') {
      if (a === b) shortedSource = true;
      cards.push(`V_${part.id} ${a} ${part.id}_internal DC 5`);
      cards.push(`R_${part.id}_esr ${part.id}_internal ${b} 1`);
      sourceCurrentNames.push(`v_${part.id}#branch`);
    } else if (part.type === 'resistor') {
      if (a !== b) cards.push(`R_${part.id} ${a} ${b} ${part.resistance}`);
    } else if (part.type === 'switch') {
      // A voltage-controlled switch keeps the circuit topology stable while
      // ngspice advances time. The control source can be altered mid-run.
      const control = `V_${part.id}_ctrl`;
      cards.push(`S_${part.id} ${a} ${b} ${part.id}_ctrl 0 VELXIO_SWITCH`);
      cards.push(`${control} ${part.id}_ctrl 0 DC ${part.closed ? 5 : 0}`);
      switchControlNames.set(part.id, control);
    } else if (part.type === 'led') {
      const sense = `V_${part.id}_sense`;
      const failureControl = `V_${part.id}_failure_ctrl`;
      cards.push(`${sense} ${a} ${part.id}_internal DC 0`);
      cards.push(`D_${part.id} ${part.id}_internal ${part.id}_after_diode DRED`);
      cards.push(`S_${part.id}_failure ${part.id}_after_diode ${b} ${part.id}_failure_ctrl 0 VELXIO_SWITCH`);
      cards.push(`${failureControl} ${part.id}_failure_ctrl 0 DC 5`);
      ledSenseNames.set(part.id, `${sense.toLowerCase()}#branch`);
      ledFailureControlNames.set(part.id, failureControl);
    }
  }
  for (const name of names.values()) cards.push(`R_bleed_${name} ${name} 0 100Meg`);
  cards.push('.model DRED D(Is=1e-14 N=2)', '.model VELXIO_SWITCH SW(Ron=0.01 Roff=1G Vt=2.5 Vh=0.1)', '.end');
  return { text: cards.join('\n'), ledSenseNames, ledFailureControlNames, sourceCurrentNames, switchControlNames, shortedSource };
}
