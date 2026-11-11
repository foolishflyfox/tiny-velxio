import type { Board, Endpoint, Hole, Part, PartType, Wire } from './circuit';

export const CIRCUIT_STORAGE_KEY = 'tiny-velxio:circuit';

export interface SavedCircuit {
  parts: Part[];
  boards: Board[];
  wires: Wire[];
  nextSequence: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function idNumber(value: unknown, prefix: 'p' | 'b' | 'w'): number | null {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[1-9]\\d*$`).test(value)) return null;
  const number = Number(value.slice(1));
  return Number.isSafeInteger(number) ? number : null;
}

function validHole(value: unknown): value is Hole {
  if (typeof value !== 'string') return false;
  const [first, second, extra] = value.split('.');
  if (extra !== undefined || second === undefined) return false;
  if (/^(?:tp|tn|bp|bn)$/.test(first)) return /^(?:[1-9]|[1-4]\d|50)$/.test(second);
  return /^(?:[1-9]|[1-5]\d|6[0-3])$/.test(first) && /^[a-j]$/.test(second);
}

function parseEndpoint(value: unknown): Endpoint | null {
  const endpoint = record(value);
  if (!endpoint) return null;
  if (endpoint.type === 'pin' && idNumber(endpoint.partId, 'p') !== null && (endpoint.pin === 'a' || endpoint.pin === 'b')) {
    return { type: 'pin', partId: endpoint.partId as string, pin: endpoint.pin };
  }
  if (endpoint.type === 'hole' && idNumber(endpoint.boardId, 'b') !== null && validHole(endpoint.hole)) {
    return { type: 'hole', boardId: endpoint.boardId as string, hole: endpoint.hole };
  }
  return null;
}

export function decodeCircuit(raw: string | null): SavedCircuit | null {
  if (raw === null) return null;
  try {
    const saved = record(JSON.parse(raw));
    if (!saved || saved.version !== 1 || !Array.isArray(saved.parts) || !Array.isArray(saved.boards) || !Array.isArray(saved.wires)) return null;
    const boards: Board[] = [];
    const parts: Part[] = [];
    const wires: Wire[] = [];
    const ids = new Set<string>();
    let nextSequence = 0;
    for (const value of saved.boards) {
      const board = record(value);
      const number = idNumber(board?.id, 'b');
      if (!board || number === null || !finiteNumber(board.x) || !finiteNumber(board.y) || ids.has(board.id as string)) return null;
      boards.push({ id: board.id as string, x: board.x, y: board.y });
      ids.add(board.id as string);
      nextSequence = Math.max(nextSequence, number);
    }
    const boardIds = new Set(boards.map((board) => board.id));
    for (const value of saved.parts) {
      const part = record(value);
      const number = idNumber(part?.id, 'p');
      if (!part || number === null || ids.has(part.id as string) || !['source', 'led', 'resistor', 'switch'].includes(part.type as string)
        || !finiteNumber(part.x) || !finiteNumber(part.y) || !finiteNumber(part.resistance)
        || part.resistance < 1 || part.resistance > 1_000_000 || (part.closed !== undefined && typeof part.closed !== 'boolean')) return null;
      const seated = part.seated === undefined ? undefined : record(part.seated);
      if (part.seated !== undefined && (!seated || typeof seated.boardId !== 'string' || !boardIds.has(seated.boardId)
        || !validHole(seated.left) || !validHole(seated.right))) return null;
      parts.push({ id: part.id as string, type: part.type as PartType, x: part.x, y: part.y,
        resistance: part.resistance, closed: part.closed === true,
        ...(seated ? { seated: { boardId: seated.boardId as string, left: seated.left as Hole, right: seated.right as Hole } } : {}) });
      ids.add(part.id as string);
      nextSequence = Math.max(nextSequence, number);
    }
    const partIds = new Set(parts.map((part) => part.id));
    for (const value of saved.wires) {
      const wire = record(value);
      const number = idNumber(wire?.id, 'w');
      const from = parseEndpoint(wire?.from);
      const to = parseEndpoint(wire?.to);
      if (!wire || number === null || ids.has(wire.id as string) || !from || !to) return null;
      if ([from, to].some((endpoint) => endpoint.type === 'pin' ? !partIds.has(endpoint.partId) : !boardIds.has(endpoint.boardId))) return null;
      wires.push({ id: wire.id as string, from, to });
      ids.add(wire.id as string);
      nextSequence = Math.max(nextSequence, number);
    }
    if (nextSequence === Number.MAX_SAFE_INTEGER) return null;
    return { parts, boards, wires, nextSequence };
  } catch {
    return null;
  }
}

export function encodeCircuit(parts: readonly Part[], boards: readonly Board[], wires: readonly Wire[]): string {
  return JSON.stringify({ version: 1, parts, boards, wires });
}
