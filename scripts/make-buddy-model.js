// Builds public/models/buddy.glb: a blocky beast made of boxes, with "Idle"
// and "Walking" animation clips. No modelling tools or dependencies needed.
// Run with: npm run model
//
// The model is 1 unit = 1 metre, stands on y = 0 and faces +Z. Materials named
// "Body" and "Accent" are re-coloured per species by the Map screen. To use
// your own character instead, replace the .glb with one that has the same two
// clip names.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'buddy.glb');

const hex = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.2); // sRGB → linear
const MATERIALS = {
  Body: '#38b764', Belly: '#a7f070', Accent: '#b13e53', Horn: '#ffcd75', Shade: '#257179', Dark: '#1a1c2c',
};

// part: [material, [width, height, depth], [centre x, y, z]]
const NODES = [
  { name: 'Buddy', children: ['Body', 'LegL', 'LegR'] },
  {
    name: 'Body', translation: [0, 0.55, 0], children: ['Head', 'WingL', 'WingR', 'Tail'],
    parts: [['Body', [0.9, 0.7, 0.7], [0, 0.35, 0]], ['Belly', [0.6, 0.5, 0.06], [0, 0.3, 0.36]]],
  },
  {
    name: 'Head', translation: [0, 0.7, 0.1],
    parts: [
      ['Body', [0.8, 0.65, 0.7], [0, 0.33, 0]],
      ['Body', [0.4, 0.25, 0.2], [0, 0.2, 0.43]],
      ['Dark', [0.12, 0.16, 0.04], [0.2, 0.42, 0.36]],
      ['Dark', [0.12, 0.16, 0.04], [-0.2, 0.42, 0.36]],
      ['Horn', [0.12, 0.26, 0.12], [0.25, 0.76, -0.1]],
      ['Horn', [0.12, 0.26, 0.12], [-0.25, 0.76, -0.1]],
    ],
  },
  { name: 'WingL', translation: [0.45, 0.5, -0.1], parts: [['Accent', [0.5, 0.4, 0.08], [0.25, 0.1, 0]]] },
  { name: 'WingR', translation: [-0.45, 0.5, -0.1], parts: [['Accent', [0.5, 0.4, 0.08], [-0.25, 0.1, 0]]] },
  {
    name: 'Tail', translation: [0, 0.15, -0.35],
    parts: [['Body', [0.2, 0.2, 0.5], [0, 0, -0.25]], ['Accent', [0.14, 0.14, 0.2], [0, 0, -0.58]]],
  },
  // Legs hang from the hip so they swing from the top.
  { name: 'LegL', translation: [0.25, 0.55, 0], parts: [['Shade', [0.28, 0.55, 0.32], [0, -0.275, 0.02]]] },
  { name: 'LegR', translation: [-0.25, 0.55, 0], parts: [['Shade', [0.28, 0.55, 0.32], [0, -0.275, 0.02]]] },
];

const rot = (axis, angle) => {
  const s = Math.sin(angle / 2);
  return [axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0, Math.cos(angle / 2)];
};
const swing = (axis, amount, times) => times.map((_, i) => rot(axis, [0, amount, 0, -amount][i % 4]));

const IDLE_T = [0, 1, 2];
const WALK_T = [0, 0.15, 0.3, 0.45, 0.6];
const REST = rot('x', 0);
const ANIMATIONS = {
  Idle: [
    ['Body', 'translation', IDLE_T, [[0, 0.55, 0], [0, 0.58, 0], [0, 0.55, 0]]],
    ['WingL', 'rotation', IDLE_T, [REST, rot('z', 0.18), REST]],
    ['WingR', 'rotation', IDLE_T, [REST, rot('z', -0.18), REST]],
    ['LegL', 'rotation', IDLE_T, [REST, REST, REST]],
    ['LegR', 'rotation', IDLE_T, [REST, REST, REST]],
    ['Tail', 'rotation', IDLE_T, [REST, rot('y', 0.1), REST]],
  ],
  Walking: [
    ['Body', 'translation', WALK_T, [[0, 0.55, 0], [0, 0.61, 0], [0, 0.55, 0], [0, 0.61, 0], [0, 0.55, 0]]],
    ['LegL', 'rotation', WALK_T, swing('x', 0.7, WALK_T)],
    ['LegR', 'rotation', WALK_T, swing('x', -0.7, WALK_T)],
    ['WingL', 'rotation', WALK_T, swing('z', 0.35, WALK_T)],
    ['WingR', 'rotation', WALK_T, swing('z', -0.35, WALK_T)],
    ['Tail', 'rotation', WALK_T, swing('y', 0.35, WALK_T)],
  ],
};

// ---------- geometry ----------

// For each face: outward normal n and two edge directions with u × v = n.
const FACES = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];

function box(size, centre, geometry) {
  const half = size.map((s) => s / 2);
  for (const [n, u, v] of FACES) {
    const base = geometry.positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let axis = 0; axis < 3; axis++) {
        geometry.positions.push(centre[axis] + half[axis] * (n[axis] + su * u[axis] + sv * v[axis]));
      }
      geometry.normals.push(...n);
    }
    geometry.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// ---------- glTF assembly ----------

const chunks = [];
let byteLength = 0;
const gltf = {
  asset: { version: '2.0', generator: 'StepBuddy make-buddy-model' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [], meshes: [], materials: [], animations: [], accessors: [], bufferViews: [], buffers: [],
};

function accessor(array, type, { target, bounds = false } = {}) {
  const bytes = Buffer.from(array.buffer);
  gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, ...(target ? { target } : {}) });
  chunks.push(bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4));
  byteLength += bytes.length + ((4 - (bytes.length % 4)) % 4);
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const entry = {
    bufferView: gltf.bufferViews.length - 1,
    componentType: array instanceof Uint16Array ? 5123 : 5126,
    count: array.length / width,
    type,
  };
  if (bounds) {
    const column = (i) => array.filter((_, j) => j % width === i);
    entry.min = Array.from({ length: width }, (_, i) => Math.min(...column(i)));
    entry.max = Array.from({ length: width }, (_, i) => Math.max(...column(i)));
  }
  gltf.accessors.push(entry);
  return gltf.accessors.length - 1;
}

const materialIndex = {};
for (const [name, color] of Object.entries(MATERIALS)) {
  materialIndex[name] = gltf.materials.length;
  gltf.materials.push({
    name,
    pbrMetallicRoughness: { baseColorFactor: [...hex(color), 1], metallicFactor: 0, roughnessFactor: 1 },
  });
}

const nodeIndex = Object.fromEntries(NODES.map((node, i) => [node.name, i]));
for (const node of NODES) {
  const entry = { name: node.name };
  if (node.translation) entry.translation = node.translation;
  if (node.children) entry.children = node.children.map((name) => nodeIndex[name]);
  if (node.parts) {
    // One primitive per material.
    const byMaterial = {};
    for (const [material, size, centre] of node.parts) {
      byMaterial[material] ??= { positions: [], normals: [], indices: [] };
      box(size, centre, byMaterial[material]);
    }
    entry.mesh = gltf.meshes.length;
    gltf.meshes.push({
      name: node.name,
      primitives: Object.entries(byMaterial).map(([material, geometry]) => ({
        attributes: {
          POSITION: accessor(new Float32Array(geometry.positions), 'VEC3', { target: 34962, bounds: true }),
          NORMAL: accessor(new Float32Array(geometry.normals), 'VEC3', { target: 34962 }),
        },
        indices: accessor(new Uint16Array(geometry.indices), 'SCALAR', { target: 34963 }),
        material: materialIndex[material],
      })),
    });
  }
  gltf.nodes.push(entry);
}

for (const [name, tracks] of Object.entries(ANIMATIONS)) {
  const animation = { name, samplers: [], channels: [] };
  for (const [node, property, times, values] of tracks) {
    animation.samplers.push({
      input: accessor(new Float32Array(times), 'SCALAR', { bounds: true }),
      output: accessor(new Float32Array(values.flat()), property === 'rotation' ? 'VEC4' : 'VEC3'),
      interpolation: 'LINEAR',
    });
    animation.channels.push({
      sampler: animation.samplers.length - 1,
      target: { node: nodeIndex[node], path: property },
    });
  }
  gltf.animations.push(animation);
}

gltf.buffers.push({ byteLength });

// GLB container: 12-byte header, JSON chunk (space padded), BIN chunk.
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, ' ')]);
const bin = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // "glTF"
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const chunkHeader = (length, type) => {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(length, 0);
  out.writeUInt32LE(type, 4);
  return out;
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([
  header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(bin.length, 0x004e4942), bin,
]));
console.log(`buddy.glb  ${12 + 16 + json.length + bin.length} bytes`);
