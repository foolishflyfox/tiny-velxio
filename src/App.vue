<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import {
  BOARD_HEIGHT, BOARD_WIDTH, CANVAS_HEIGHT, CANVAS_WIDTH, COLS, PITCH, RAILS, ROWS, ROW_Y, X0,
  buildNetlist, endpointKey, endpointPoint, findSeat, holeGroup, holePoint,
  type Board, type Endpoint, type Hole, type Part, type PartType, type Wire,
} from './circuit';
import { NgSpiceInteractive } from './spice/NgSpiceInteractive';

const palette: { type: PartType; title: string; description: string; mark: string }[] = [
  { type: 'source', title: '电源', description: '5V 直流', mark: '⏚' },
  { type: 'led', title: 'LED', description: '红色发光二极管', mark: '✳' },
  { type: 'resistor', title: '电阻', description: '默认 220Ω', mark: 'Ω' },
  { type: 'switch', title: '开关', description: '点击切换通断', mark: '⎋' },
];
const parts = ref<Part[]>([]);
const boards = ref<Board[]>([]);
const wires = ref<Wire[]>([]);
const canvasRef = ref<SVGSVGElement | null>(null);
const scrollerRef = ref<HTMLDivElement | null>(null);
const selectedPartId = ref<string | null>(null);
const selectedBoardId = ref<string | null>(null);
const selectedWireId = ref<string | null>(null);
const wireStart = ref<Endpoint | null>(null);
const cursor = ref<{ x: number; y: number } | null>(null);
const status = ref('拖入元件，然后点击两个引脚接线；面包板可以按需添加。');
const phase = ref<'idle' | 'starting' | 'running' | 'error'>('idle');
const ledCurrents = ref<Record<string, number>>({});
const sourceCurrent = ref<number | null>(null);
const simulationTime = ref(0);
const selectedPart = computed(() => parts.value.find((p) => p.id === selectedPartId.value) ?? null);
const selectedBoard = computed(() => boards.value.find((b) => b.id === selectedBoardId.value) ?? null);
const allHoles = computed(() => {
  const holes: Hole[] = [];
  for (let col = 1; col <= COLS; col++) for (const row of ROWS) holes.push(`${col}.${row}`);
  for (let col = 1; col <= 50; col++) for (const rail of RAILS) holes.push(`${rail}.${col}`);
  return holes;
});
let sequence = 0;
let solver: NgSpiceInteractive | null = null;
let runEpoch = 0;
const pendingSwitches = new Map<string, boolean>();
let panning: { pointerId: number; clientX: number; clientY: number } | null = null;

function markDirty(message = '电路已更改，点击“开始运行”查看结果。') {
  if (phase.value === 'starting' || phase.value === 'running') stopSimulation();
  ledCurrents.value = {};
  sourceCurrent.value = null;
  phase.value = 'idle';
  status.value = message;
}
function pointFromEvent(event: MouseEvent | DragEvent | PointerEvent) {
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: (event.clientX - rect.left) * CANVAS_WIDTH / rect.width, y: (event.clientY - rect.top) * CANVAS_HEIGHT / rect.height };
}
function clampPart(x: number, y: number) {
  return { x: Math.max(15, Math.min(CANVAS_WIDTH - 75, x)), y: Math.max(58, Math.min(CANVAS_HEIGHT - 15, y)) };
}
function seatPart(part: Part) {
  const seat = findSeat(part, boards.value, parts.value);
  part.seated = seat;
  if (seat) {
    const board = boards.value.find((candidate) => candidate.id === seat.boardId)!;
    const point = holePoint(seat.left);
    part.x = board.x + point.x;
    part.y = board.y + point.y;
  }
}
function addPart(type: PartType, x: number, y: number) {
  const part: Part = { id: `p${++sequence}`, type, ...clampPart(x, y), resistance: 220, closed: false };
  parts.value.push(part);
  seatPart(part);
  selectedPartId.value = part.id;
  selectedBoardId.value = null;
  selectedWireId.value = null;
  markDirty(`${palette.find((entry) => entry.type === type)?.title}已添加。`);
}
function addBoard(x: number, y: number) {
  const board: Board = { id: `b${++sequence}`, x: Math.max(10, Math.min(CANVAS_WIDTH - BOARD_WIDTH - 10, x)), y: Math.max(45, Math.min(CANVAS_HEIGHT - BOARD_HEIGHT - 10, y)) };
  boards.value.push(board);
  selectedBoardId.value = board.id;
  selectedPartId.value = null;
  selectedWireId.value = null;
  markDirty('面包板已添加。点击孔位或元件引脚可以接线。');
}
function onPaletteDrag(event: DragEvent, type: PartType | 'board') {
  event.dataTransfer?.setData('text/plain', type);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
}
function onDrop(event: DragEvent) {
  event.preventDefault();
  const type = event.dataTransfer?.getData('text/plain');
  const point = pointFromEvent(event);
  if (type === 'board') addBoard(point.x - 100, point.y - 70);
  else if (type === 'source' || type === 'led' || type === 'resistor' || type === 'switch') addPart(type, point.x - 30, point.y + 18);
}
function addByClick(type: PartType | 'board') {
  if (type === 'board') addBoard(120 + boards.value.length * 35, 250 + boards.value.length * 35);
  else addPart(type, 180 + parts.value.length * 115, 160 + (parts.value.length % 2) * 120);
}

function electricalKey(endpoint: Endpoint) {
  if (endpoint.type === 'hole') return endpointKey(endpoint);
  const part = parts.value.find((candidate) => candidate.id === endpoint.partId);
  if (!part?.seated) return endpointKey(endpoint);
  const hole = endpoint.pin === 'a' ? part.seated.left : part.seated.right;
  return `${part.seated.boardId}:${holeGroup(hole)}`;
}
function endpointName(endpoint: Endpoint) {
  return endpoint.type === 'hole' ? `${endpoint.boardId} · ${endpoint.hole}` : `${endpoint.partId} · ${endpoint.pin === 'a' ? '左' : '右'}引脚`;
}
function onEndpointClick(endpoint: Endpoint, event: MouseEvent) {
  event.stopPropagation();
  selectedPartId.value = null; selectedBoardId.value = null; selectedWireId.value = null;
  if (!wireStart.value) {
    wireStart.value = endpoint;
    status.value = `已选择 ${endpointName(endpoint)}，点击另一端完成导线；按 Esc 取消。`;
    return;
  }
  const from = wireStart.value;
  wireStart.value = null;
  cursor.value = null;
  if (endpointKey(from) === endpointKey(endpoint)) return;
  if (electricalKey(from) === electricalKey(endpoint)) { status.value = '这两端已经相通。'; return; }
  if (wires.value.some((wire) =>
    (endpointKey(wire.from) === endpointKey(from) && endpointKey(wire.to) === endpointKey(endpoint)) ||
    (endpointKey(wire.to) === endpointKey(from) && endpointKey(wire.from) === endpointKey(endpoint)))) {
    status.value = '这两端已有导线。'; return;
  }
  wires.value.push({ id: `w${++sequence}`, from, to: endpoint });
  markDirty('导线已连接。');
}
function onCanvasMove(event: MouseEvent) { if (wireStart.value) cursor.value = pointFromEvent(event); }
function beginPan(event: PointerEvent) {
  if (event.button !== 0 || !scrollerRef.value) return;
  panning = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
  (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
}
function continuePan(event: PointerEvent) {
  if (!panning || panning.pointerId !== event.pointerId || !scrollerRef.value) return;
  scrollerRef.value.scrollLeft -= event.clientX - panning.clientX;
  scrollerRef.value.scrollTop -= event.clientY - panning.clientY;
  panning.clientX = event.clientX;
  panning.clientY = event.clientY;
}
function endPan(event: PointerEvent) {
  if (panning?.pointerId === event.pointerId) panning = null;
}
function clearSelection() {
  selectedPartId.value = null; selectedBoardId.value = null; selectedWireId.value = null;
  wireStart.value = null; cursor.value = null;
}
function removeSelected() {
  if (selectedPartId.value) {
    const id = selectedPartId.value;
    parts.value = parts.value.filter((part) => part.id !== id);
    wires.value = wires.value.filter((wire) => ![wire.from, wire.to].some((endpoint) => endpoint.type === 'pin' && endpoint.partId === id));
    selectedPartId.value = null;
    markDirty('元件已删除。');
  } else if (selectedBoardId.value) {
    const id = selectedBoardId.value;
    boards.value = boards.value.filter((board) => board.id !== id);
    for (const part of parts.value) if (part.seated?.boardId === id) part.seated = undefined;
    wires.value = wires.value.filter((wire) => ![wire.from, wire.to].some((endpoint) => endpoint.type === 'hole' && endpoint.boardId === id));
    selectedBoardId.value = null;
    markDirty('面包板已删除。');
  } else if (selectedWireId.value) {
    wires.value = wires.value.filter((wire) => wire.id !== selectedWireId.value);
    selectedWireId.value = null;
    markDirty('导线已删除。');
  }
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { clearSelection(); status.value = '已取消当前操作。'; }
  if ((event.key === 'Delete' || event.key === 'Backspace') && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault(); removeSelected();
  }
}
window.addEventListener('keydown', onKeydown);
onUnmounted(() => { window.removeEventListener('keydown', onKeydown); stopSimulation(); });

let moving: { type: 'part' | 'board'; id: string; clientX: number; clientY: number; x: number; y: number; moved: boolean } | null = null;
function beginMove(event: PointerEvent, type: 'part' | 'board', id: string) {
  event.stopPropagation();
  if (wireStart.value) return;
  const item = type === 'part' ? parts.value.find((part) => part.id === id) : boards.value.find((board) => board.id === id);
  if (!item) return;
  selectedPartId.value = type === 'part' ? id : null;
  selectedBoardId.value = type === 'board' ? id : null;
  selectedWireId.value = null;
  moving = { type, id, clientX: event.clientX, clientY: event.clientY, x: item.x, y: item.y, moved: false };
  (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
}
function continueMove(event: PointerEvent) {
  if (!moving) return;
  const dx = event.clientX - moving.clientX;
  const dy = event.clientY - moving.clientY;
  if (Math.abs(dx) + Math.abs(dy) < 4) return;
  moving.moved = true;
  if (moving.type === 'part') {
    const part = parts.value.find((candidate) => candidate.id === moving!.id);
    if (part) { Object.assign(part, clampPart(moving.x + dx, moving.y + dy)); part.seated = undefined; }
  } else {
    const board = boards.value.find((candidate) => candidate.id === moving!.id);
    if (!board) return;
    const nextX = Math.max(10, Math.min(CANVAS_WIDTH - BOARD_WIDTH - 10, moving.x + dx));
    const nextY = Math.max(45, Math.min(CANVAS_HEIGHT - BOARD_HEIGHT - 10, moving.y + dy));
    const boardDx = nextX - board.x;
    const boardDy = nextY - board.y;
    board.x = nextX; board.y = nextY;
    for (const part of parts.value) if (part.seated?.boardId === board.id) { part.x += boardDx; part.y += boardDy; }
  }
}
function toggleSwitch(part: Part) {
  if (part.type !== 'switch') return;
  part.closed = !part.closed;
  if (phase.value === 'starting' || phase.value === 'running') {
    pendingSwitches.set(part.id, part.closed);
    status.value = `开关已${part.closed ? '闭合' : '断开'}，将在下一个时间步生效。`;
  } else {
    status.value = `开关已${part.closed ? '闭合' : '断开'}。点击“开始运行”查看结果。`;
  }
}
function endMove(event?: PointerEvent) {
  if (!moving) return;
  if (moving.moved) {
    if (moving.type === 'part') {
      const part = parts.value.find((candidate) => candidate.id === moving!.id);
      if (part) seatPart(part);
    }
    markDirty(moving.type === 'part' ? '元件已移动。' : '面包板已移动。');
  } else if (moving.type === 'part' && event?.type !== 'pointercancel') {
    const part = parts.value.find((candidate) => candidate.id === moving!.id);
    if (part?.type === 'switch') toggleSwitch(part);
  }
  moving = null;
}
function updateResistance(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!selectedPart.value || selectedPart.value.type !== 'resistor') return;
  if (!Number.isFinite(value) || value < 1 || value > 1_000_000) { status.value = '电阻值需在 1Ω 至 1MΩ 之间。'; return; }
  selectedPart.value.resistance = value;
  markDirty('电阻值已更新。');
}

function stopSimulation() {
  ++runEpoch;
  pendingSwitches.clear();
  solver?.dispose();
  solver = null;
  ledCurrents.value = {};
  sourceCurrent.value = null;
  simulationTime.value = 0;
  phase.value = 'idle';
  status.value = '已停止运行。';
}

async function startSimulation() {
  if (phase.value === 'starting' || phase.value === 'running') return;
  if (!parts.value.some((part) => part.type === 'source')) { phase.value = 'error'; status.value = '请先加入电源。'; return; }
  if (!parts.value.some((part) => part.type === 'led')) { phase.value = 'error'; status.value = '请先加入 LED。'; return; }
  const deck = buildNetlist(parts.value, wires.value);
  if (deck.shortedSource) { phase.value = 'error'; status.value = '电源正负极被导线或面包板直接短接。'; return; }
  const epoch = ++runEpoch;
  const engine = new NgSpiceInteractive();
  solver = engine;
  simulationTime.value = 0;
  phase.value = 'starting';
  status.value = '正在启动 ngspice 瞬态仿真…';
  try {
    await engine.init();
    await engine.loadNetlist(deck.text);
    const breakpoint = await engine.command('stop when time = 1m');
    if (breakpoint.rc !== 0) throw new Error(breakpoint.stderr.at(-1) ?? '无法设置仿真时间步');
    // The first breakpoint returns control to the UI. Subsequent `step`
    // commands continue this same transient plot and preserve device state.
    const initial = await engine.command('tran 0.1m 60 0 0.1m');
    if (initial.rc !== 0) throw new Error(initial.stderr.at(-1) ?? '瞬态仿真启动失败');
    if (epoch !== runEpoch) return;
    const available = await engine.listVectors();
    const wanted = [...deck.ledSenseNames.values(), ...deck.sourceCurrentNames, 'time'];
    const names = wanted.map((wantedName) => available.find((name) => name.toLowerCase() === wantedName) ?? wantedName);
    const sample = async () => {
      const entries = await engine.readLastVecs(names);
      if (epoch !== runEpoch) return;
      const values = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.value]));
      const time = values.get('time');
      if (time === null || time === undefined || !Number.isFinite(time)) throw new Error('SPICE 未返回仿真时间');
      simulationTime.value = time;
      const nextCurrents: Record<string, number> = {};
      for (const [id, name] of deck.ledSenseNames) {
        const current = values.get(name);
        if (current === null || current === undefined || !Number.isFinite(current)) throw new Error(`SPICE 未返回 ${id} 的瞬态电流`);
        nextCurrents[id] = Math.max(0, current);
      }
      ledCurrents.value = nextCurrents;
      sourceCurrent.value = Math.abs(values.get(deck.sourceCurrentNames[0] ?? '') ?? 0);
      const lit = Object.values(nextCurrents).filter((current) => current > 0.0001).length;
      status.value = `运行中 · 仿真时间 ${time.toFixed(3)} s · ${lit} 个 LED 点亮 · 电源电流 ${((sourceCurrent.value ?? 0) * 1000).toFixed(1)} mA`;
    };
    phase.value = 'running';
    await sample();
    while (epoch === runEpoch) {
      const changes = [...pendingSwitches];
      pendingSwitches.clear();
      for (const [id, closed] of changes) {
        const source = deck.switchControlNames.get(id);
        if (source) {
          const changed = await engine.command(`alter ${source} dc ${closed ? 5 : 0}`);
          if (changed.rc !== 0) throw new Error(changed.stderr.at(-1) ?? '无法更新开关状态');
        }
      }
      const advanced = await engine.command('step 100');
      if (advanced.rc !== 0) throw new Error(advanced.stderr.at(-1) ?? '瞬态仿真推进失败');
      await sample();
      if (simulationTime.value >= 59.999) {
        stopSimulation();
        status.value = '已到达 60 秒仿真时间；点击“开始运行”可重新开始。';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  } catch (error) {
    if (epoch !== runEpoch) return;
    engine.dispose();
    solver = null;
    phase.value = 'error';
    status.value = `运行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
function ledLit(id: string) { return (ledCurrents.value[id] ?? 0) > 0.0001; }
function wirePath(wire: Wire) {
  const a = endpointPoint(wire.from, parts.value, boards.value);
  const b = endpointPoint(wire.to, parts.value, boards.value);
  if (!a || !b) return '';
  const mid = Math.min(a.y, b.y) - 24;
  return `M ${a.x} ${a.y} L ${a.x} ${mid} L ${b.x} ${mid} L ${b.x} ${b.y}`;
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-icon">V</span><div><strong>velxio</strong><small>电路工作台</small></div></div>
      <div class="sidebar-section-title">元器件 <span>4 个</span></div>
      <div class="palette-list">
        <button v-for="entry in palette" :key="entry.type" class="palette-card" draggable="true" @dragstart="onPaletteDrag($event, entry.type)" @click="addByClick(entry.type)">
          <span class="palette-mark" :class="entry.type">{{ entry.mark }}</span><span class="palette-copy"><strong>{{ entry.title }}</strong><small>{{ entry.description }}</small></span><span class="palette-plus">＋</span>
        </button>
      </div>
      <div class="sidebar-section-title board-section-title">搭建工具 <span>可选</span></div>
      <button class="palette-card" draggable="true" @dragstart="onPaletteDrag($event, 'board')" @click="addByClick('board')">
        <span class="palette-mark board-mark">▦</span><span class="palette-copy"><strong>面包板</strong><small>830 孔，可拖动</small></span><span class="palette-plus">＋</span>
      </button>
      <p class="palette-tip">拖到画布放置，或点击直接添加。</p>
      <div class="sidebar-spacer"></div>
      <div v-if="selectedPart" class="selection-card">
        <div class="selection-heading"><span>已选元件</span><button @click="removeSelected">删除</button></div>
        <strong>{{ palette.find((entry) => entry.type === selectedPart?.type)?.title }} <small>#{{ selectedPart.id.slice(1) }}</small></strong>
        <label v-if="selectedPart.type === 'resistor'" class="value-label">电阻值（Ω）<input type="number" min="1" max="1000000" step="1" :value="selectedPart.resistance" @change="updateResistance" /></label>
        <p v-if="selectedPart.type === 'led'">左端 A 为正极，右端 C 为负极。</p>
        <p v-if="selectedPart.type === 'source'">左端为 +5V，右端为负极。</p>
        <button v-if="selectedPart.type === 'switch'" class="switch-toggle" :aria-pressed="selectedPart.closed" @click="toggleSwitch(selectedPart)">{{ selectedPart.closed ? '闭合 · 点击断开' : '断开 · 点击闭合' }}</button>
        <p class="selection-foot">拖动元件可调整位置。</p>
      </div>
      <div v-else-if="selectedBoard" class="selection-card"><div class="selection-heading"><span>已选面包板</span><button @click="removeSelected">删除</button></div><p>拖动板体可调整位置。元件放在孔位上会自动插入。</p></div>
      <div v-else-if="selectedWireId" class="selection-card"><div class="selection-heading"><span>已选导线</span><button @click="removeSelected">删除</button></div><p>点击导线可选中，按 Delete 也能删除。</p></div>
      <div v-else class="help-card"><strong>快速开始</strong><ol><li>拖入电源、电阻、LED 和开关</li><li>点击引脚，连接成闭合回路</li><li>点击「开始运行」，再点击开关控制 LED</li></ol></div>
    </aside>
    <main class="workspace">
      <header class="toolbar"><div class="toolbar-title"><div class="eyebrow">CIRCUIT EDITOR <span>／</span> 01</div><h1>电路编辑器</h1></div><div class="toolbar-actions"><span class="engine-label"><i></i> ngspice · 瞬态</span><button class="run-button" :disabled="phase === 'starting' || phase === 'running'" @click="startSimulation"><span>{{ phase === 'starting' || phase === 'running' ? '◌' : '▶' }}</span> {{ phase === 'starting' ? '启动中' : phase === 'running' ? '运行中' : '开始运行' }}</button><button class="stop-button" :disabled="phase !== 'starting' && phase !== 'running'" @click="stopSimulation"><span>■</span> 停止运行</button></div></header>
      <div class="workspace-head"><span>工作区 <b>／ 自由画布</b></span><span>{{ parts.length }} 个元件 · {{ boards.length }} 块面包板 · {{ wires.length }} 根导线</span></div>
      <div ref="scrollerRef" class="board-scroller" @dragover.prevent @drop="onDrop">
        <div class="board-stage">
          <svg ref="canvasRef" class="breadboard" :viewBox="`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`" xmlns="http://www.w3.org/2000/svg" @mousemove="onCanvasMove" @click="clearSelection">
            <defs><pattern id="boardTexture" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".35" fill="#dddcd5" /></pattern><filter id="boardShadow" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="11" stdDeviation="13" flood-color="#51677a" flood-opacity=".18" /></filter><filter id="ledGlow"><feGaussianBlur stdDeviation="6" /></filter></defs>
            <rect class="canvas-pan-area" x="0" y="0" :width="CANVAS_WIDTH" :height="CANVAS_HEIGHT" fill="transparent" @pointerdown="beginPan" @pointermove="continuePan" @pointerup="endPan" @pointercancel="endPan" />
            <text v-if="parts.length === 0 && boards.length === 0" x="750" y="415" class="empty-title">从左侧拖入元件，开始搭建电路</text>
            <text v-if="parts.length === 0 && boards.length === 0" x="750" y="445" class="empty-subtitle">元件可直接接线 · 面包板按需添加</text>
            <g v-for="board in boards" :key="board.id" class="board-instance" :class="{ selected: selectedBoardId === board.id }" :transform="`translate(${board.x}, ${board.y})`">
              <rect x="12" y="12" width="1076" height="418" rx="16" fill="#f5f5ef" stroke="#deded6" filter="url(#boardShadow)" @pointerdown="beginMove($event, 'board', board.id)" @pointermove="continueMove" @pointerup="endMove" @pointercancel="endMove" />
              <rect x="13" y="13" width="1074" height="416" rx="15" fill="url(#boardTexture)" opacity=".55" class="board-surface" @pointerdown="beginMove($event, 'board', board.id)" @pointermove="continueMove" @pointerup="endMove" @pointercancel="endMove" />
              <rect x="39" y="226" width="1023" height="15" rx="4" fill="#e5e5de" pointer-events="none" />
              <path d="M 49 43 H 1044 M 49 96 H 1044 M 49 350 H 1044 M 49 404 H 1044" stroke="#dadbd5" stroke-width="1.3" pointer-events="none" />
              <path d="M 55 48 H 1038 M 55 399 H 1038" stroke="#d96760" stroke-width="2" opacity=".75" pointer-events="none" />
              <path d="M 55 91 H 1038 M 55 355 H 1038" stroke="#698db1" stroke-width="2" opacity=".75" pointer-events="none" />
              <text x="31" y="83" class="rail-label plus">+</text><text x="31" y="63" class="rail-label minus">−</text><text x="31" y="391" class="rail-label plus">+</text><text x="31" y="371" class="rail-label minus">−</text>
              <template v-for="col in COLS" :key="`num-${col}`"><text v-if="col === 1 || col % 5 === 0" :x="X0 + (col - 1) * PITCH" y="116" class="column-number">{{ col }}</text><text v-if="col === 1 || col % 5 === 0" :x="X0 + (col - 1) * PITCH" y="341" class="column-number">{{ col }}</text></template>
              <template v-for="row in ROWS" :key="`row-${row}`"><text x="49" :y="ROW_Y[row] + 3" class="row-letter">{{ row }}</text><text x="1041" :y="ROW_Y[row] + 3" class="row-letter">{{ row }}</text></template>
              <g class="holes"><circle v-for="hole in allHoles" :key="hole" :cx="holePoint(hole).x" :cy="holePoint(hole).y" r="4.25" :class="{ active: wireStart?.type === 'hole' && wireStart.boardId === board.id && wireStart.hole === hole }" @pointerdown.stop @click="onEndpointClick({ type: 'hole', boardId: board.id, hole }, $event)" /></g>
            </g>
            <g class="wires"><g v-for="wire in wires" :key="wire.id" :class="{ selected: selectedWireId === wire.id }" @click.stop="selectedWireId = wire.id; selectedPartId = null; selectedBoardId = null; wireStart = null"><path :d="wirePath(wire)" class="wire-hit" /><path :d="wirePath(wire)" class="wire-stroke" /><circle v-if="endpointPoint(wire.from, parts, boards)" :cx="endpointPoint(wire.from, parts, boards)?.x" :cy="endpointPoint(wire.from, parts, boards)?.y" r="5" /><circle v-if="endpointPoint(wire.to, parts, boards)" :cx="endpointPoint(wire.to, parts, boards)?.x" :cy="endpointPoint(wire.to, parts, boards)?.y" r="5" /></g></g>
            <path v-if="wireStart && cursor && endpointPoint(wireStart, parts, boards)" class="preview-wire" :d="`M ${endpointPoint(wireStart, parts, boards)?.x} ${endpointPoint(wireStart, parts, boards)?.y} L ${cursor.x} ${cursor.y}`" />
            <g v-for="part in parts" :key="part.id" class="part" :class="[part.type, { selected: selectedPartId === part.id, lit: part.type === 'led' && ledLit(part.id) }]" :transform="`translate(${part.x}, ${part.y})`">
              <g @pointerdown="beginMove($event, 'part', part.id)" @pointermove="continueMove" @pointerup="endMove" @pointercancel="endMove">
                <line x1="0" y1="0" x2="0" y2="-18" class="lead" /><line x1="60" y1="0" x2="60" y2="-18" class="lead" /><line x1="0" y1="-18" x2="12" y2="-18" class="lead" /><line x1="48" y1="-18" x2="60" y2="-18" class="lead" />
                <rect v-if="part.type === 'source'" x="10" y="-42" width="40" height="47" rx="7" class="part-body source-body" />
                <template v-if="part.type === 'source'"><text x="30" y="-23" class="part-text source-text">5V</text><text x="17" y="-7" class="terminal-text positive">＋</text><text x="43" y="-7" class="terminal-text">−</text></template>
                <template v-if="part.type === 'resistor'"><rect x="12" y="-30" width="36" height="23" rx="5" class="part-body resistor-body" /><path d="M 17 -19 l 5 -6 l 5 12 l 5 -12 l 5 12 l 5 -6" fill="none" stroke="#775846" stroke-width="1.8" pointer-events="none" /><text x="30" y="-34" class="value-text">{{ part.resistance }}Ω</text></template>
                <template v-if="part.type === 'switch'"><rect x="11" y="-34" width="38" height="27" rx="5" class="part-body switch-body" :class="{ closed: part.closed }" /><circle cx="18" cy="-20" r="2.5" class="switch-contact" /><circle cx="42" cy="-20" r="2.5" class="switch-contact" /><line x1="18" y1="-20" :x2="part.closed ? 42 : 39" :y2="part.closed ? -20 : -29" class="switch-lever" /><text x="30" y="-39" class="value-text switch-label">{{ part.closed ? 'ON' : 'OFF' }}</text></template>
                <template v-if="part.type === 'led'"><circle v-if="ledLit(part.id)" cx="30" cy="-19" r="19" fill="#ff483e" opacity=".6" filter="url(#ledGlow)" /><circle cx="30" cy="-19" r="13" class="led-body" /><path d="M 25 -25 L 25 -13 L 35 -19 Z" fill="#fff0e5" pointer-events="none" /><line x1="37" y1="-25" x2="37" y2="-13" stroke="#fff0e5" stroke-width="2" pointer-events="none" /><text x="5" y="-32" class="terminal-text">A</text><text x="55" y="-32" class="terminal-text">C</text></template>
              </g>
              <circle cx="0" cy="0" r="6" class="pin-tip" @pointerdown.stop @click="onEndpointClick({ type: 'pin', partId: part.id, pin: 'a' }, $event)" /><circle cx="60" cy="0" r="6" class="pin-tip" @pointerdown.stop @click="onEndpointClick({ type: 'pin', partId: part.id, pin: 'b' }, $event)" />
            </g>
          </svg>
        </div>
      </div>
      <footer class="status-bar"><span class="status-dot" :class="phase"></span><span>{{ status }}</span><span class="status-hint">点击两个引脚或孔位接线 · Esc 取消 · Delete 删除</span></footer>
    </main>
  </div>
</template>
