# Tiny Velxio

一个采用自由画布的 Vue 3 电路编辑器。电源、LED 和电阻可直接接线；面包板是按需添加的搭建工具。浏览器内的 ngspice WebAssembly 负责直流工作点计算。

## 本地运行

需要 Node.js 22 或更新版本。

```bash
npm install
npm run dev
```

构建和检查：

```bash
npm test
npm run build
```

## 操作

从左侧拖入元件，或点击元件卡片直接添加。元件可放在画布任意位置，拖动主体可调整位置。面包板也可以拖入、移动或删除；放到面包板孔位上的元件会自动插入。面包板每列上方五孔相通、下方五孔相通，四条电源轨各自连通。

点击第一个引脚或孔位，再点击第二个引脚或孔位添加导线。点击导线、元件或面包板后可按 Delete 删除；Esc 取消接线。选中电阻可修改阻值。点击“运行电路”执行 ngspice 直流分析，LED 根据正向电流点亮。

一个可用的连接顺序是：电源正极 → 电阻 → LED 的 A 极 → LED 的 C 极 → 电源负极。导线连接到引脚或孔位；移动元件后导线会跟随引脚，插在面包板中的元件会重新对齐附近孔位。

ngspice WASM 文件的来源和许可见 `public/wasm/ngspice-interactive/PROVENANCE.md`。
