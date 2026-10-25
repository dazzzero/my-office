import { Html, useGLTF } from '@react-three/drei';
import { useMemo } from 'react';
import { Box3, Color, Vector3, type Mesh, type MeshStandardMaterial, type Object3D } from 'three';
import type { Area, Block, FloorPlan, Placement } from './layout.ts';

const url = (model: string) => `/assets/furniture/${model}.glb`;

/** Kenney 모델은 원점이 모서리에 있어서, 바닥 중심이 (0,0)이 되도록 한 번 계산해 둔다 */
const centers = new WeakMap<Object3D, Vector3>();
function footprintCenter(scene: Object3D): Vector3 {
  let c = centers.get(scene);
  if (!c) {
    const box = new Box3().setFromObject(scene);
    c = new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    centers.set(scene, c);
  }
  return c;
}

/** Kenney 기본색(빨강·분홍) 대신 레퍼런스처럼 차분한 색. 빨간 계열 재질만 바꾼다 */
const TINT: Record<string, string> = {
  chairDesk: '#7d8896',
  stoolBar: '#9aa3ae',
  chairModernCushion: '#6f8fb5',
  loungeSofa: '#6c8fb8',
  loungeChair: '#6c8fb8',
  rugRectangle: '#c8d5e3',
};
const isReddish = (c: Color) => c.r > c.g + 0.15 && c.r > c.b + 0.15;

function Model({ p }: { p: Placement }) {
  const { scene } = useGLTF(url(p.model));
  const obj = useMemo(() => {
    const o = scene.clone();
    const tint = TINT[p.model];
    o.traverse(n => {
      const mesh = n as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (!tint) return;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MeshStandardMaterial[];
      const next = mats.map(m => (m.color && isReddish(m.color) ? Object.assign(m.clone(), { color: new Color(tint) }) : m));
      mesh.material = Array.isArray(mesh.material) ? next : next[0];
    });
    return o;
  }, [scene, p.model]);
  const c = footprintCenter(scene);
  return (
    <group position={[p.x, p.y ?? 0, p.z]} rotation={[0, p.rot ?? 0, 0]}>
      <primitive object={obj} position={[-c.x, -c.y, -c.z]} />
    </group>
  );
}

function BlockMesh({ b }: { b: Block }) {
  const pos: [number, number, number] = [b.x + b.w / 2, (b.y ?? 0) + b.h / 2, b.z + b.d / 2];
  if (b.kind === 'glass') {
    return (
      <mesh position={pos}>
        <boxGeometry args={[b.w, b.h, b.d]} />
        <meshStandardMaterial color={b.color} transparent opacity={0.28} roughness={0.1} depthWrite={false} />
      </mesh>
    );
  }
  if (b.kind === 'window') {
    return (
      <mesh position={pos}>
        <boxGeometry args={[b.w, b.h, b.d]} />
        <meshStandardMaterial color={b.color} emissive="#9fc3e0" emissiveIntensity={0.35} />
      </mesh>
    );
  }
  if (b.kind === 'rack') {
    return (
      <group position={pos}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial color={b.color} roughness={0.6} />
        </mesh>
        {Array.from({ length: 6 }, (_, j) => (
          <mesh key={j} position={[-b.w / 2 + 0.12, -b.h / 2 + 0.2 + j * 0.15, b.d / 2 + 0.005]}>
            <planeGeometry args={[0.05, 0.025]} />
            <meshBasicMaterial color={j % 3 === 2 ? '#ffb020' : '#35d07f'} />
          </mesh>
        ))}
      </group>
    );
  }
  if (b.kind === 'elevator') {
    return (
      <group position={pos}>
        <mesh receiveShadow>
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial color={b.color} metalness={0.4} roughness={0.35} />
        </mesh>
        <mesh position={[b.w / 2 + 0.002, 0, 0]}>
          <boxGeometry args={[0.004, b.h, 0.015]} />
          <meshStandardMaterial color="#6f7986" />
        </mesh>
        <mesh position={[b.w / 2 + 0.003, b.h / 2 + 0.08, 0]}>
          <boxGeometry args={[0.004, 0.08, 0.3]} />
          <meshBasicMaterial color="#2b313b" />
        </mesh>
      </group>
    );
  }
  return (
    <mesh position={pos} castShadow={b.kind !== 'wall'} receiveShadow>
      <boxGeometry args={[b.w, b.h, b.d]} />
      <meshStandardMaterial color={b.color} roughness={0.85} />
    </mesh>
  );
}

function Floor({ areas }: { areas: Area[] }) {
  return (
    <group>
      {/* 바닥판 두께 */}
      <mesh position={[areas[0].w / 2, -0.06, areas[0].d / 2]} receiveShadow>
        <boxGeometry args={[areas[0].w, 0.12, areas[0].d]} />
        <meshStandardMaterial color="#dfe3e9" />
      </mesh>
      {areas.map((a, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[a.x + a.w / 2, 0.001 + i * 0.001, a.z + a.d / 2]} receiveShadow>
          <planeGeometry args={[a.w, a.d]} />
          <meshStandardMaterial color={a.color} roughness={0.95} />
        </mesh>
      ))}
      {areas.filter(a => a.label).map((a, i) => (
        <Html key={`l${i}`} position={[a.x + 0.15, 0.02, a.z + a.d - 0.15]} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
          <div className="zone-label">{a.label}</div>
        </Html>
      ))}
    </group>
  );
}

export function FloorStatic({ plan }: { plan: FloorPlan }) {
  return (
    <group>
      <Floor areas={plan.areas} />
      {plan.blocks.map((b, i) => <BlockMesh key={i} b={b} />)}
      {plan.placements.map((p, i) => <Model key={i} p={p} />)}
    </group>
  );
}

export function preloadFurniture(plan: FloorPlan) {
  for (const m of new Set(plan.placements.map(p => p.model))) useGLTF.preload(url(m));
}
