import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/meshopt_decoder.module.js";
import { DEFAULT_MODEL_ID, MODELS } from "./models.js";

const METALS = {
  orig:   { name: "Original finish", color: null },
  yellow: { name: "Yellow gold", color: [1.0, 0.66, 0.26] },
  white:  { name: "White gold",  color: [0.86, 0.86, 0.85] },
  rose:   { name: "Rose gold",   color: [0.98, 0.58, 0.44] },
};

const DRACO_PATH = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/";
const SAFE_GLB_RE = /^[a-zA-Z0-9._-]+\.glb$/;
const METAL_NAME_RE = /metal|gold|silver|platinum|shank|band|prong|bezel/i;

function resolveProduct(defaultId) {
  const params = new URLSearchParams(location.search);
  const p = params.get("p");
  const rawGlb = params.get("glb");

  if (p) {
    if (Object.prototype.hasOwnProperty.call(MODELS, p)) {
      return MODELS[p];
    }
    return null;
  }

  if (rawGlb) {
    if (!SAFE_GLB_RE.test(rawGlb)) return null;
    const rawBack = params.get("back");
    const safeBack = rawBack && rawBack.startsWith("../") ? rawBack : "../#work";
    return {
      id: "custom",
      title: params.get("title") || rawGlb.replace(/\.glb$/i, ""),
      glb: rawGlb,
      subtitle: params.get("subtitle") || "",
      description: params.get("desc") || "",
      back: safeBack,
      materialMode: params.get("mode") || "smart-metal",
      defaultMetal: params.get("metal") || "orig",
    };
  }

  return MODELS[defaultId] || MODELS[DEFAULT_MODEL_ID] || null;
}

function isMetalSourceMaterial(src, totalMaterials) {
  if (!src) return true;
  if (totalMaterials === 1) return true;
  if (src.transmission && src.transmission > 0.05) return false;
  if (src.transparent && src.opacity < 0.95) return false;
  if (typeof src.metalness === "number" && src.metalness >= 0.5) return true;
  if (src.name && METAL_NAME_RE.test(src.name)) return true;
  return false;
}

function createShadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, "rgba(30,32,36,0.55)");
  r.addColorStop(0.45, "rgba(30,32,36,0.22)");
  r.addColorStop(1, "rgba(30,32,36,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function initViewer({ defaultId = DEFAULT_MODEL_ID } = {}) {
  const params = new URLSearchParams(location.search);
  const EMBED = params.has("embed");
  const MODAL = params.has("modal");
  if (EMBED) document.body.classList.add("embed");
  if (MODAL) document.body.classList.add("modal");

  const product = resolveProduct(defaultId);
  const loadingEl = document.getElementById("loading");
  const titleEl = document.getElementById("productTitle");
  const noteEl = document.getElementById("productNote");
  const metalNameEl = document.getElementById("metalName");
  const backEl = document.getElementById("backLink");
  const origBtn = document.querySelector('[data-metal="orig"]');

  if (!product) {
    if (titleEl) titleEl.textContent = "Model not found";
    if (loadingEl) {
      loadingEl.textContent = "The requested 3D model is not available";
      loadingEl.classList.add("error");
    }
    return;
  }

  document.title = `${product.title} in 3D · Hamit Reyhani`;
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc && product.description) {
    metaDesc.setAttribute("content", product.description);
  }
  if (titleEl) titleEl.textContent = product.title;
  if (noteEl) {
    noteEl.textContent = product.subtitle || product.description || "";
    noteEl.hidden = !noteEl.textContent;
  }
  if (backEl && product.back) {
    backEl.setAttribute("href", product.back);
  }

  const host = document.getElementById("stage");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e6e8e9");
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.6;
  if (EMBED) {
    controls.enableZoom = false;
    renderer.domElement.style.touchAction = "pan-y";
  }

  // Studio light: brown_photostudio_02 (Poly Haven, CC0), 1k.
  const pmrem = new THREE.PMREMGenerator(renderer);
  new RGBELoader().load("studio_1k.hdr", (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
  });

  const metalMats = [];
  let activeMetal = METALS[product.defaultMetal] ? product.defaultMetal : "yellow";

  function createMetalMaterial(src, preserveInitialColor) {
    const m = new THREE.MeshPhysicalMaterial({
      metalness: 1,
      roughness: 0.06,
      envMapIntensity: 1.15,
      side: THREE.DoubleSide,
    });
    if (preserveInitialColor && src && src.color) {
      m.color.copy(src.color);
    } else {
      const preset = METALS[activeMetal]?.color || METALS.yellow.color;
      m.color.setRGB(...preset, THREE.LinearSRGBColorSpace);
    }
    m.userData.orig = m.color.clone();
    metalMats.push(m);
    return m;
  }

  function setMetal(key) {
    if (!METALS[key]) return;
    activeMetal = key;
    for (const m of metalMats) {
      if (key === "orig") m.color.copy(m.userData.orig);
      else m.color.setRGB(...METALS[key].color, THREE.LinearSRGBColorSpace);
    }
    if (metalNameEl) metalNameEl.textContent = METALS[key].name;
    document.querySelectorAll("[data-metal]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.metal === key));
    });
  }

  if (origBtn) {
    origBtn.hidden = product.materialMode === "all-metal";
  }
  setMetal(activeMetal);

  let home = null;
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  draco.setDecoderConfig({ type: "js" });
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);

  loader.load(
    product.glb,
    (gltf) => {
      const root = gltf.scene;
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const wrap = new THREE.Group();
      root.position.sub(center);
      root.position.y += size.y / 2;
      wrap.add(root);
      scene.add(wrap);

      const distinctSrc = new Set();
      root.traverse((o) => {
        if (o.isMesh && o.material) distinctSrc.add(o.material);
      });

      const bySrc = new Map();
      const mode = product.materialMode || "smart-metal";
      const preserveOrig = activeMetal === "orig" || mode === "original";

      root.traverse((o) => {
        if (!o.isMesh) return;
        const src = o.material;
        if (mode === "original") {
          return;
        }
        if (mode === "all-metal" || isMetalSourceMaterial(src, distinctSrc.size)) {
          if (!bySrc.has(src)) {
            bySrc.set(src, createMetalMaterial(src, preserveOrig));
          }
          o.material = bySrc.get(src);
        }
      });

      if (metalMats.length === 0 && origBtn) {
        document.querySelectorAll("[data-metal]").forEach((b) => {
          b.hidden = b.dataset.metal !== "orig";
        });
        setMetal("orig");
      } else {
        setMetal(activeMetal);
      }

      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: createShadowTexture(),
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        })
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.01;
      shadow.scale.set(size.x * 1.25, size.z * 1.25, 1);
      scene.add(shadow);

      const radius = size.length() / 2 || 1;
      const target = new THREE.Vector3(0, size.y * 0.55, 0);
      const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
      const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
      const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 0.95;
      const dir = new THREE.Vector3(0.55, 0.45, 1).normalize();
      home = { pos: target.clone().addScaledVector(dir, dist), target };
      camera.position.copy(home.pos);
      controls.target.copy(target);
      controls.minDistance = dist * 0.3;
      controls.maxDistance = dist * 2.2;
      camera.near = dist / 100;
      camera.far = dist * 20;
      camera.updateProjectionMatrix();
      controls.update();
      loadingEl.classList.add("done");
    },
    (ev) => {
      if (ev.total) {
        loadingEl.textContent = "Loading the model · " + Math.round((ev.loaded / ev.total) * 100) + "%";
      }
    },
    (err) => {
      loadingEl.textContent = "The model could not be loaded";
      loadingEl.classList.add("error");
      console.error(err);
    }
  );

  document.querySelectorAll("[data-metal]").forEach((b) => {
    b.addEventListener("click", () => setMetal(b.dataset.metal));
  });

  const spin = document.getElementById("spin");
  if (spin) {
    spin.addEventListener("click", () => {
      controls.autoRotate = !controls.autoRotate;
      spin.setAttribute("aria-pressed", String(controls.autoRotate));
    });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      controls.autoRotate = false;
      spin.setAttribute("aria-pressed", "false");
    }
  }

  const resetBtn = document.getElementById("reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (!home) return;
      camera.position.copy(home.pos);
      controls.target.copy(home.target);
      controls.update();
    });
  }

  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}
