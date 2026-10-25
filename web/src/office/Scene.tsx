import { Html, MapControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import { PCFShadowMap } from 'three';
import type { FloorConfig } from '../../../shared/src/config.ts';
import type { Worker } from '../../../shared/src/events.ts';
import { HOT_COLOR, teamColor, workerModel, workerName } from '../../../shared/src/identity.ts';
import { useOffice } from '../store.ts';
import { SpotAllocator, type Placed } from './allocate.ts';
import { Character } from './Character.tsx';
import { FloorStatic } from './Furniture.tsx';
import { D, W, WALL_H, buildFloorPlan, type FloorPlan } from './layout.ts';
import { Ticker, activity } from './ticker.ts';

const CENTER: [number, number, number] = [W / 2, 0, D / 2];

const CAMERA_POS: [number, number, number] = [CENTER[0] + 20, 17, CENTER[2] + 20];

/** 화면 밖 버튼(+, −)이 보내는 확대/축소 */
export function zoomBy(factor: number) {
  window.dispatchEvent(new CustomEvent('office-zoom', { detail: factor }));
}

/** 층 전체가 화면에 들어오는 배율·위치. zoomKey가 바뀌면(⟲ 버튼) 처음 상태로 */
function FitCamera({ zoomKey }: { zoomKey: number }) {
  const { camera, size, invalidate } = useThree();
  const controls = useThree(s => s.controls) as unknown as { target: { set: (...v: number[]) => void }; update: () => void } | null;
  useEffect(() => {
    const span = (W + D) / Math.SQRT2;
    // 개발 확인용: ?focus=x,z,zoom 이면 그 지점을 크게
    const focus = new URLSearchParams(location.search).get('focus')?.split(',').map(Number);
    const [fx, fz] = focus ? [focus[0], focus[1]] : [CENTER[0], CENTER[2]];
    camera.position.set(fx + 20, 17, fz + 20);
    controls?.target.set(fx, 0, fz);
    camera.zoom = focus?.[2] ?? Math.min(size.width / (span + 1.5), size.height / (span * 0.62 + WALL_H + 1.5));
    camera.updateProjectionMatrix();
    controls?.update();
    invalidate();
  }, [camera, controls, size.width, size.height, invalidate, zoomKey]);
  useEffect(() => {
    const onZoom = (e: Event) => {
      camera.zoom = Math.min(200, Math.max(15, camera.zoom * (e as CustomEvent<number>).detail));
      camera.updateProjectionMatrix();
      invalidate();
    };
    window.addEventListener('office-zoom', onZoom);
    return () => window.removeEventListener('office-zoom', onZoom);
  }, [camera, invalidate]);
  return null;
}

/** ?debug 이면 성능 측정용으로 렌더러를 window.__office에 노출 */
function DebugHandle() {
  const { gl, scene, camera, invalidate } = useThree();
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('debug')) return;
    (window as unknown as { __office: unknown }).__office = { gl, scene, camera, invalidate, activity };
  }, [gl, scene, camera, invalidate]);
  return null;
}

function IslandSigns({ plan, floor }: { plan: FloorPlan; floor: FloorConfig }) {
  return (
    <>
      {plan.islands.map(i => (
        <Html key={i.teamId} position={[i.x, 0.85, i.z]} center zIndexRange={[15, 10]} style={{ pointerEvents: 'none' }}>
          <div className="team-sign" style={{ borderColor: i.hot ? HOT_COLOR : teamColor(floor, i.teamId) }}>{i.name}</div>
        </Html>
      ))}
    </>
  );
}

/** 회의 중이면 회의실 위에 안건 표지판 (누르면 회의 보기) */
function MeetingSign({ floor }: { floor: FloorConfig }) {
  const m = useOffice(s => s.meetings.find(x => x.floor === floor.floor && ['research', 'debate', 'minutes'].includes(x.status)));
  const openPanel = useOffice(s => s.openPanel);
  if (!m) return null;
  const stage = m.status === 'research' ? '조사' : m.status === 'debate' ? '토론' : '정리';
  return (
    <Html position={[12.6, 2.1, 5.1]} center zIndexRange={[16, 10]}>
      <div className="meeting-sign" onClick={() => openPanel({ meetingId: m.id })}>🗣️ 회의 중 · {stage}<b>{m.title}</b></div>
    </Html>
  );
}

function Workers({ plan, floor }: { plan: FloorPlan; floor: FloorConfig }) {
  const workers = useOffice(s => s.workers);
  const departing = useOffice(s => s.departing);
  const selectedId = useOffice(s => s.selectedWorkerId);
  const selectWorker = useOffice(s => s.selectWorker);
  const finishDeparture = useOffice(s => s.finishDeparture);

  const allocator = useMemo(() => new SpotAllocator(plan), [plan]);
  // 이 층을 처음 그릴 때 이미 있던 직원들
  const initial = useRef<Set<string> | null>(null);

  const list = useMemo(() => {
    const here = (w: Worker) => w.floor === floor.floor;
    return [
      ...Object.values(workers).filter(here).map(w => ({ w, departing: false })),
      ...Object.values(departing).filter(here).map(w => ({ w, departing: true })),
    ];
  }, [workers, departing, floor.floor]);
  initial.current ??= new Set(list.map(x => x.w.id));

  // 도구가 바뀌면 기다리지 않고 바로 그 공간으로 (사용자 결정 2026-10-25)
  const spots = useMemo(
    () => allocator.assign(list.map(({ w, departing }): Placed => ({ ...w, departing }))),
    [allocator, list],
  );

  return (
    <>
      {list.map(({ w, departing }) => (
        <Character
          key={w.id}
          worker={w}
          name={workerName(w)}
          model={workerModel(w)}
          color={teamColor(floor, w.teamId)}
          spot={spots.get(w.id)!}
          plan={plan}
          startAtSpot={initial.current!.has(w.id) && !departing}
          departing={departing}
          selected={selectedId === w.id}
          onSelect={() => selectWorker(w.id)}
          onGone={() => departing && finishDeparture(w.id)}
        />
      ))}
    </>
  );
}

export function OfficeScene({ floor, zoomKey }: { floor: FloorConfig; zoomKey: number }) {
  const plan = useMemo(() => buildFloorPlan(floor), [floor]);
  const selectWorker = useOffice(s => s.selectWorker);
  return (
    <Canvas
      key={floor.floor}
      frameloop="demand"
      dpr={[1, 1.5]}
      shadows={{ type: PCFShadowMap }}
      orthographic
      camera={{ position: CAMERA_POS, near: 0.1, far: 200, zoom: 40 }}
      onPointerMissed={() => selectWorker(null)}
    >
      <color attach="background" args={['#eef0f4']} />
      <hemisphereLight args={['#ffffff', '#b9c0cc', 1.6]} />
      <directionalLight
        position={[CENTER[0] + 6, 14, CENTER[2] + 10]}
        intensity={1.9}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
        shadow-camera-near={1}
        shadow-camera-far={50}
      >
        <object3D attach="target" position={CENTER} />
      </directionalLight>
      <FitCamera zoomKey={zoomKey} />
      <MapControls makeDefault target={CENTER} enableRotate={false} minZoom={15} maxZoom={200} screenSpacePanning />
      <Suspense fallback={null}>
        <FloorStatic plan={plan} />
        <IslandSigns plan={plan} floor={floor} />
        <MeetingSign floor={floor} />
        <Workers plan={plan} floor={floor} />
      </Suspense>
      <Ticker />
      <DebugHandle />
    </Canvas>
  );
}
