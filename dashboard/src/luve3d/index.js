// dashboard/src/luve3d/index.js: entrada do arquivo à parte dist/luve3d.js (proposta Crie seu Luve §5 e §8 Q2). O bundle
// principal NÃO importa nada daqui: o carregador único da interface (luve3d/load.ts, URL constante) põe este arquivo na página
// só quando o estúdio abre, e ele se registra em window.__LUVEBOT_LUVE3D__ (contrato em api.d.ts). Se o WebGL faltar, mount()
// lança e quem chamou mostra a prévia 2D.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { isRecipe } from "../../../assets/mascots/luve.mjs";
import { buildLuve3d } from "./mascot3d.js";

const FOV = 30, TILT = 0.1;

function dispose(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of [o.material].flat()) { m.map?.dispose(); m.dispose(); }
  });
}

/** Desenha o Luve da receita no canvas, com giro por arrasto. opts.reducedMotion: sem balanço sozinho (padrão: o do sistema). */
function mount(canvas, recipe, { state = "idle", reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches } = {}) {
  if (!isRecipe(recipe)) throw new Error("luve3d: receita inválida");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Luz de produto dos Reels: ambiente de sala, luz principal com sombra e dois contraluzes da marca.
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.45;
  const key = new THREE.DirectionalLight("#ffffff", 2.4); key.position.set(-2.5, 6, 6); key.target.position.set(0, 0.4, 0); scene.add(key, key.target);
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0003; key.shadow.normalBias = 0.02;
  Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 1.2, bottom: -1.2 });
  const rimL = new THREE.DirectionalLight("#a78bfa", 2.2); rimL.position.set(-5, 2.5, -5);
  const rimR = new THREE.DirectionalLight("#22c3f7", 1.8); rimR.position.set(5, 2.5, -5);
  scene.add(rimL, rimR, new THREE.HemisphereLight("#9aa6ff", "#0b0f19", 0.15));
  // Chão invisível que só recebe a sombra macia (ajuda a ler o volume); fica fora do PNG.
  const ground = new THREE.Mesh(new THREE.CircleGeometry(1.2, 48), new THREE.ShadowMaterial({ opacity: 0.18 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 30);
  const pivot = new THREE.Group(); scene.add(pivot);
  let luve = null, yaw = 0, drag = null, frame = 0, dirty = true, t0 = performance.now();

  const frameLuve = () => { // enquadra o Luve inteiro (corpo, satélite e acessório), com folga para o balanço
    const box = new THREE.Box3().setFromObject(luve), c = box.getCenter(new THREE.Vector3()), d = box.getSize(new THREE.Vector3());
    const size = Math.max(d.y, Math.hypot(d.x, d.z)) * 1.1;
    const dist = size / 2 / Math.tan((FOV * Math.PI) / 360) + d.z / 2;
    camera.position.set(c.x, c.y + dist * TILT, dist); camera.lookAt(c.x, c.y, 0);
  };
  const set = (r, s = state) => {
    if (!isRecipe(r)) throw new Error("luve3d: receita inválida");
    const next = buildLuve3d(r, { state: s });
    if (luve) { pivot.remove(luve); dispose(luve); }
    luve = next; pivot.add(luve); frameLuve(); dirty = true;
  };
  const resize = () => {
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
  };
  const tick = (now) => {
    frame = requestAnimationFrame(tick);
    const idle = !reducedMotion && !drag;
    if (idle) {
      const t = (now - t0) / 1000;
      pivot.rotation.y = yaw + Math.sin(t * 0.6) * 0.28;
      const prop = luve.getObjectByName("prop"); if (prop) prop.rotation.y = t * 9;
      dirty = true;
    } else pivot.rotation.y = yaw;
    if (dirty) { renderer.render(scene, camera); dirty = false; }
  };

  const down = (e) => { drag = { x: e.clientX, yaw }; canvas.setPointerCapture(e.pointerId); };
  const move = (e) => { if (drag) { yaw = drag.yaw + (e.clientX - drag.x) * 0.012; dirty = true; } };
  const up = () => { drag = null; t0 = performance.now(); };
  const front = () => { yaw = 0; t0 = performance.now(); dirty = true; };
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up); canvas.addEventListener("dblclick", front);
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  canvas.style.touchAction = "none";

  set(recipe); resize(); frame = requestAnimationFrame(tick);

  return {
    set: (r) => set(r),
    /** PNG quadrado, fundo transparente, o Luve de frente. */
    toPNG(size = 1024) {
      const keep = { w: canvas.width, h: canvas.height, ratio: renderer.getPixelRatio(), aspect: camera.aspect, rot: pivot.rotation.y };
      renderer.setPixelRatio(1); renderer.setSize(size, size, false); camera.aspect = 1; camera.updateProjectionMatrix();
      pivot.rotation.y = 0; ground.visible = false;
      renderer.render(scene, camera);
      const blob = new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("luve3d: PNG"))), "image/png"));
      ground.visible = true; pivot.rotation.y = keep.rot;
      renderer.setPixelRatio(keep.ratio); resize(); dirty = true;
      return blob;
    },
    dispose() {
      cancelAnimationFrame(frame); ro.disconnect();
      for (const [k, f] of [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up], ["dblclick", front]]) canvas.removeEventListener(k, f);
      if (luve) dispose(luve);
      dispose(scene); scene.environment?.dispose(); pmrem.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
}

window.__LUVEBOT_LUVE3D__ = Object.freeze({ version: 1, mount });
