import { Html, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimationMixer, type AnimationAction, type Group, type Mesh } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Worker } from '../../../shared/src/events.ts';
import type { FloorPlan, Spot } from './layout.ts';
import { findPath, type Point } from './path.ts';
import { activity } from './ticker.ts';

const SPEED = 2.2;
const TURN = 10;
/** 앉는 애니메이션이 의자 높이에 맞도록 */
const SIT_LIFT = 0.12;

export const characterUrl = (model: string) => `/assets/characters/character-${model}.glb`;

const STATUS_ICON: Partial<Record<Worker['status'], string>> = { waiting: '✋', error: '⚠️', away: '💤' };

interface Props {
  worker: Worker;
  name: string;
  model: string;
  color: string;
  spot: Spot;
  plan: FloorPlan;
  /** 화면을 열었을 때 이미 있던 직원은 엘리베이터가 아니라 자기 자리에서 시작 */
  startAtSpot: boolean;
  departing: boolean;
  selected: boolean;
  onSelect: () => void;
  onGone: () => void;
}

function angleTo(from: number, to: number, t: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * Math.min(1, t);
}

export function Character({ worker, name, model, color, spot, plan, startAtSpot, departing, selected, onSelect, onGone }: Props) {
  const gltf = useGLTF(characterUrl(model));
  const scene = useMemo(() => {
    const s = cloneSkinned(gltf.scene);
    s.traverse(n => { if ((n as Mesh).isMesh) n.castShadow = true; });
    return s;
  }, [gltf.scene]);
  const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  const actions = useMemo(() => {
    const map: Record<string, AnimationAction> = {};
    for (const clip of gltf.animations) map[clip.name] = mixer.clipAction(clip);
    return map;
  }, [gltf.animations, mixer]);

  const group = useRef<Group>(null);
  const start = startAtSpot ? spot : plan.elevator;
  const st = useRef({
    x: start.x, z: start.z, rot: start.rot,
    path: [] as Point[], spotKey: '', anim: '', settle: 0, gone: false,
  });
  // 걷는 중엔 말풍선을 숨긴다. 출발·도착 때만 바뀌는 React 상태
  const [moving, setMoving] = useState(false);

  // 자리(또는 상태)가 바뀌면 새 경로
  useEffect(() => {
    const s = st.current;
    if (s.spotKey === spot.key && !departing) return;
    s.spotKey = spot.key;
    s.path = Math.hypot(s.x - spot.x, s.z - spot.z) < 0.05 ? [] : findPath(plan.grid, [s.x, s.z], [spot.x, spot.z]);
    s.settle = 0.5;
    setMoving(s.path.length > 0);
    activity.start(worker.id);
  }, [spot, departing, plan.grid, worker.id]);

  // 일하는 중/대기 전환 시 자세 갱신
  useEffect(() => {
    st.current.settle = 0.5;
    activity.start(worker.id);
  }, [worker.status, worker.id]);

  useEffect(() => () => { activity.stop(worker.id); mixer.stopAllAction(); }, [mixer, worker.id]);

  const play = (name: string) => {
    const s = st.current;
    if (s.anim === name || !actions[name]) return;
    const next = actions[name];
    next.reset().fadeIn(0.2).play();
    if (s.anim && actions[s.anim]) actions[s.anim].fadeOut(0.2);
    s.anim = name;
    s.settle = Math.max(s.settle, 0.35);
  };

  useFrame((_, delta) => {
    const s = st.current;
    const g = group.current;
    if (!g || s.gone) return;
    const dt = Math.min(delta, 0.1);
    let walking = false;

    if (s.path.length) {
      walking = true;
      let step = SPEED * dt;
      while (step > 0 && s.path.length) {
        const [tx, tz] = s.path[0];
        const dx = tx - s.x, dz = tz - s.z, len = Math.hypot(dx, dz);
        if (len > 0.001) s.rot = angleTo(s.rot, Math.atan2(dx, dz), TURN * dt);
        if (len <= step) { s.x = tx; s.z = tz; s.path.shift(); step -= len; }
        else { s.x += (dx / len) * step; s.z += (dz / len) * step; step = 0; }
      }
      play('walk');
      if (!s.path.length) setMoving(false);
    } else {
      s.rot = angleTo(s.rot, spot.rot, TURN * dt);
      if (departing || worker.status === 'left') {
        // 엘리베이터에 도착 → 퇴장
        s.gone = true;
        g.visible = false;
        activity.stop(worker.id);
        onGone();
        return;
      }
      if (spot.pose === 'sit') play('sit');
      else play(worker.status === 'working' ? 'interact-right' : 'idle');
      s.settle -= dt;
      if (s.settle <= 0) activity.stop(worker.id);
    }

    mixer.update(dt);
    const sitting = !walking && spot.pose === 'sit';
    g.position.set(s.x, sitting ? SIT_LIFT : 0, s.z);
    g.rotation.y = s.rot;
  });

  const icon = STATUS_ICON[worker.status];
  // 걷는 중에도 하는 일을 보여준다 (도구 호출이 걷는 시간보다 잦아서 숨기면 거의 안 보임)
  const showBubble = !departing && worker.status !== 'left';
  return (
    <group ref={group} position={[st.current.x, 0, st.current.z]} onClick={e => { e.stopPropagation(); onSelect(); }}>
      <primitive object={scene} />
      <Html position={[0, 0.95, 0]} center zIndexRange={[100, 20]} style={{ pointerEvents: 'none' }}>
        <div className={`worker-tag${selected ? ' selected' : ''}${moving ? ' moving' : ''}`}>
          {showBubble && (
            <div className={`bubble status-${worker.status}`}>
              {icon && <span className="bubble-icon">{icon}</span>}
              {worker.tool && worker.status === 'working' && <b>{worker.tool}</b>}
              {worker.summary}
            </div>
          )}
          <div className="name" style={{ background: color }}>{name}</div>
        </div>
      </Html>
    </group>
  );
}
