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
const SAFE_GLB_RE = /^[a-zA-Z0-9._-]+\.(glb|bin)$/;
const METAL_NAME_RE = /metal|gold|silver|platinum|shank|band|prong|bezel/i;
const GEM_NAME_RE = /gem|diamond|stone|ruby|sapphire|emerald|crystal/i;

function resolveProduct(defaultId) {
  const params = new URLSearchParams(location.search);
  const p = params.get("p");
  const rawGlb = params.get("glb") || params.get("enc");

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
      title: params.get("title") || rawGlb.replace(/\.(glb|bin)$/i, ""),
      glb: rawGlb,
      encrypted: /\.bin$/i.test(rawGlb) || params.has("enc"),
      subtitle: params.get("subtitle") || "",
      description: params.get("desc") || "",
      back: safeBack,
      materialMode: params.get("mode") || "smart-metal",
      defaultMetal: params.get("metal") || "orig",
    };
  }

  return MODELS[defaultId] || MODELS[DEFAULT_MODEL_ID] || null;
}

async function fetchEncryptedPayload(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Could not fetch encrypted model");
  const total = Number(resp.headers.get("content-length")) || 0;
  if (resp.body && total && onProgress) {
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress({ loaded, total });
    }
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }
  return new Uint8Array(await resp.arrayBuffer());
}

async function decryptPayloadWithPin(rawBytes, pinStr) {
  const salt = rawBytes.slice(0, 16);
  const iv = rawBytes.slice(16, 28);
  const ciphertext = rawBytes.slice(28);
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(pinStr.trim()),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 250000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
}

function isGemSourceMaterial(src) {
  if (!src) return false;
  if (src.name && GEM_NAME_RE.test(src.name)) return true;
  const rp = src.userData?.rootPath || "";
  if (GEM_NAME_RE.test(rp) || /\.dmat$/i.test(rp)) return true;
  if (typeof src.metalness === "number" && src.metalness < 0.15 && (!src.name || !METAL_NAME_RE.test(src.name))) {
    return true;
  }
  return false;
}

function isMetalSourceMaterial(src, totalMaterials) {
  if (!src) return true;
  if (isGemSourceMaterial(src)) return false;
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
  const CLIENT = params.has("client");
  if (EMBED) document.body.classList.add("embed");
  if (MODAL || CLIENT) document.body.classList.add("modal");

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

  document.title = CLIENT ? `${product.title} · 3D Preview` : `${product.title} in 3D · Hamit Reyhani`;
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
  controls.enablePan = !EMBED;
  controls.screenSpacePanning = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.6;
  if (EMBED) {
    controls.enableZoom = false;
    renderer.domElement.style.touchAction = "pan-y";
  }

  // Studio light: brown_photostudio_02 (Poly Haven, CC0), 1k.
  const pmrem = new THREE.PMREMGenerator(renderer);
  let gemShaderMat = null;
  let hdrEquirectTex = null;
  new RGBELoader().load("studio_1k.hdr", (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    hdrEquirectTex = tex;
    const envScene = new THREE.Scene();
    envScene.background = tex;
    // Slight blur (0.018 radians) takes the sharp edge off HDR details while keeping crisp metallic realism
    scene.environment = pmrem.fromScene(envScene, 0.018).texture;
    if (gemShaderMat) {
      gemShaderMat.uniforms.tEnv.value = hdrEquirectTex;
    }
  });

  const metalMats = [];
  let activeMetal = METALS[product.defaultMetal] ? product.defaultMetal : "yellow";

  function createMetalMaterial(src, preserveInitialColor) {
    const m = new THREE.MeshPhysicalMaterial({
      metalness: 1,
      roughness: 0.045,
      envMapIntensity: 1.18,
      side: THREE.DoubleSide,
    });
    const rp = (src && src.userData && src.userData.rootPath) ? String(src.userData.rootPath) : "";
    if (/whitegold|silver|platinum/i.test(rp)) {
      m.color.setRGB(...METALS.white.color, THREE.LinearSRGBColorSpace);
    } else if (/yellowgold|rosegold/i.test(rp)) {
      m.color.setRGB(...METALS.yellow.color, THREE.LinearSRGBColorSpace);
    } else if (preserveInitialColor && src && src.color) {
      m.color.copy(src.color);
    } else {
      const preset = METALS[activeMetal]?.color || METALS.yellow.color;
      m.color.setRGB(...preset, THREE.LinearSRGBColorSpace);
    }
    m.userData.orig = m.color.clone();
    metalMats.push(m);
    return m;
  }

  function buildGemBVH(geom) {
    const pos = geom.attributes.position;
    const idx = geom.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const data = new Float32Array(triCount * 12);
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < triCount; i++) {
      const i0 = idx ? idx.getX(i * 3) : i * 3;
      const i1 = idx ? idx.getX(i * 3 + 1) : i * 3 + 1;
      const i2 = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
      vA.fromBufferAttribute(pos, i0);
      vB.fromBufferAttribute(pos, i1);
      vC.fromBufferAttribute(pos, i2);
      e1.subVectors(vB, vA);
      e2.subVectors(vC, vA);
      n.crossVectors(e1, e2).normalize();
      const base = i * 12;
      data[base + 0] = vA.x; data[base + 1] = vA.y; data[base + 2] = vA.z; data[base + 3] = 0;
      data[base + 4] = e1.x; data[base + 5] = e1.y; data[base + 6] = e1.z; data[base + 7] = 0;
      data[base + 8] = e2.x; data[base + 9] = e2.y; data[base + 10] = e2.z; data[base + 11] = 0;
    }
    const width = 64;
    const totalVec4 = triCount * 3;
    const height = Math.ceil(totalVec4 / width);
    const padded = new Float32Array(width * height * 4);
    padded.set(data);
    const tex = new THREE.DataTexture(padded, width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    return { tex, triCount, width, height };
  }

  function createGemMaterial(src, geom) {
    if (gemShaderMat) return gemShaderMat;
    const bvh = buildGemBVH(geom);
    gemShaderMat = new THREE.ShaderMaterial({
      uniforms: {
        tTri: { value: bvh.tex },
        tEnv: { value: hdrEquirectTex },
        uTriCount: { value: bvh.triCount },
        uTexSize: { value: new THREE.Vector2(bvh.width, bvh.height) },
      },
      vertexShader: `
        varying vec3 vLocalPos;
        varying vec3 vLocalNormal;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vCamLocal;
        varying mat3 vLocalToWorld;
        void main() {
          vLocalPos = position;
          // Use flat facet normals via derivatives in fragment or vertex normal
          vLocalNormal = normalize(normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          mat4 invModel = inverse(modelMatrix);
          vCamLocal = (invModel * vec4(cameraPosition, 1.0)).xyz;
          vLocalToWorld = mat3(
            normalize(modelMatrix[0].xyz),
            normalize(modelMatrix[1].xyz),
            normalize(modelMatrix[2].xyz)
          );
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tTri;
        uniform sampler2D tEnv;
        uniform int uTriCount;
        uniform vec2 uTexSize;

        varying vec3 vLocalPos;
        varying vec3 vLocalNormal;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vCamLocal;
        varying mat3 vLocalToWorld;

        const float PI = 3.14159265359;

        vec4 fetchVec4(int idx) {
          int x = idx - (idx / 64) * 64;
          int y = idx / 64;
          return texelFetch(tTri, ivec2(x, y), 0);
        }

        vec3 sampleEnv(vec3 worldDir) {
          vec3 d = normalize(worldDir);
          vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
          // Add virtual bright jeweler studio overhead spotlights for crisp diamond fire & scintillation
          vec3 envCol = texture2D(tEnv, uv).rgb;
          float spot1 = pow(max(0.0, dot(d, normalize(vec3(0.35, 0.88, 0.32)))), 48.0) * 14.0;
          float spot2 = pow(max(0.0, dot(d, normalize(vec3(-0.45, 0.82, -0.35)))), 40.0) * 11.0;
          float spot3 = pow(max(0.0, dot(d, normalize(vec3(0.0, 0.96, -0.28)))), 64.0) * 16.0;
          float ringLight = smoothstep(0.55, 0.72, d.y) * (1.0 - smoothstep(0.75, 0.88, d.y)) * 2.4;
          return envCol * 1.35 + vec3(spot1 + spot2 + spot3 + ringLight);
        }

        float fresnelSchlick(float cosTheta, float ior1, float ior2) {
          float r0 = (ior1 - ior2) / (ior1 + ior2);
          r0 = r0 * r0;
          float c = clamp(1.0 - cosTheta, 0.0, 1.0);
          float r = r0 + (1.0 - r0) * (c * c * c * c * c);
          return r;
        }

        bool intersectInternal(vec3 orig, vec3 dir, out float tHit, out vec3 nHit) {
          tHit = 1e9;
          bool found = false;
          for (int i = 0; i < 360; i++) {
            if (i >= uTriCount) break;
            int base = i * 3;
            vec3 v0 = fetchVec4(base).xyz;
            vec3 e1 = fetchVec4(base + 1).xyz;
            vec3 e2 = fetchVec4(base + 2).xyz;
            vec3 pvec = cross(dir, e2);
            float det = dot(e1, pvec);
            // We want exit hit from inside -> back-facing or front-facing with t > 0.002
            if (abs(det) < 1e-6) continue;
            float invDet = 1.0 / det;
            vec3 tvec = orig - v0;
            float u = dot(tvec, pvec) * invDet;
            if (u < 0.0 || u > 1.0) continue;
            vec3 qvec = cross(tvec, e1);
            float v = dot(dir, qvec) * invDet;
            if (v < 0.0 || u + v > 1.0) continue;
            float t = dot(e2, qvec) * invDet;
            if (t > 0.005 && t < tHit) {
              tHit = t;
              nHit = normalize(cross(e1, e2));
              found = true;
            }
          }
          return found;
        }

        vec3 traceChannel(vec3 rayOrig, vec3 rayDir, float ior) {
          vec3 p = rayOrig;
          vec3 d = rayDir;
          float throughput = 1.0;
          vec3 accum = vec3(0.0);
          for (int bounce = 0; bounce < 5; bounce++) {
            float tHit;
            vec3 nOut;
            if (!intersectInternal(p, d, tHit, nOut)) {
              accum += throughput * sampleEnv(vLocalToWorld * d);
              break;
            }
            p = p + d * tHit;
            // Inside the gem, normal pointing inward is -nOut (if nOut is outward)
            vec3 nIn = dot(d, nOut) > 0.0 ? -nOut : nOut;
            float cosI = clamp(dot(-d, nIn), 0.0, 1.0);
            float sinT2 = ior * ior * (1.0 - cosI * cosI);
            if (sinT2 >= 1.0) {
              // Total Internal Reflection (TIR) inside diamond pavilion!
              d = reflect(d, nIn);
              throughput *= 0.985;
            } else {
              float cosT = sqrt(1.0 - sinT2);
              float r0 = (ior - 1.0) / (ior + 1.0);
              r0 = r0 * r0;
              float c = 1.0 - cosT;
              float F = r0 + (1.0 - r0) * (c * c * c * c * c);
              vec3 refrDir = refract(d, nIn, ior);
              accum += throughput * (1.0 - F) * sampleEnv(vLocalToWorld * refrDir);
              throughput *= F * 0.98;
              d = reflect(d, nIn);
              if (throughput < 0.04) break;
            }
          }
          return accum;
        }

        void main() {
          // Flat facet normal in local space for crisp diamond facet edges
          vec3 dx = dFdx(vLocalPos);
          vec3 dy = dFdy(vLocalPos);
          vec3 flatN = normalize(cross(dx, dy));
          if (dot(flatN, vLocalNormal) < 0.0) flatN = -flatN;

          vec3 viewDirLocal = normalize(vLocalPos - vCamLocal);
          float cosTheta = clamp(dot(-viewDirLocal, flatN), 0.0, 1.0);
          float F = fresnelSchlick(cosTheta, 1.0, 2.417);

          vec3 reflLocal = reflect(viewDirLocal, flatN);
          vec3 reflColor = sampleEnv(vLocalToWorld * reflLocal);

          // Chromatic dispersion across R, G, B (diamond IOR 2.407 -> 2.424 -> 2.451)
          vec3 dirR = refract(viewDirLocal, flatN, 1.0 / 2.405);
          vec3 dirG = refract(viewDirLocal, flatN, 1.0 / 2.424);
          vec3 dirB = refract(viewDirLocal, flatN, 1.0 / 2.452);

          float colR = traceChannel(vLocalPos, dirR, 2.405).r;
          float colG = traceChannel(vLocalPos, dirG, 2.424).g;
          float colB = traceChannel(vLocalPos, dirB, 2.452).b;

          vec3 internalColor = vec3(colR, colG, colB) * vec3(0.99, 0.995, 1.02);
          vec3 finalColor = mix(internalColor, reflColor, F);

          gl_FragColor = vec4(finalColor, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    return gemShaderMat;
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

  function onGltfLoaded(gltf) {
    const root = gltf.scene;
    root.traverse((o) => {
      if (o.userData && o.userData._agOrigScale) {
        const s = o.userData._agOrigScale;
        o.scale.set(s[0], s[1], s[2]);
        delete o.userData._agOrigScale;
      }
      if (o.userData && o.userData._agRestore) {
        const r = o.userData._agRestore;
        if (r.t) o.position.set(r.t[0], r.t[1], r.t[2]);
        if (r.s) o.scale.set(r.s[0], r.s[1], r.s[2]);
        delete o.userData._agRestore;
      }
    });
    root.updateMatrixWorld(true);
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
    const gemBySrc = new Map();
    const mode = product.materialMode || "smart-metal";
    const preserveOrig = activeMetal === "orig" || mode === "original";

    root.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.material;
      if (isGemSourceMaterial(src)) {
        if (!gemBySrc.has(src)) {
          gemBySrc.set(src, createGemMaterial(src, o.geometry));
        }
        o.material = gemBySrc.get(src);
        return;
      }
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

    wrap.updateMatrixWorld(true);
    const ring1Meshes = [];
    const ring2Meshes = [];
    const wb = new THREE.Box3();
    const wc = new THREE.Vector3();
    root.traverse((o) => {
      if (!o.isMesh) return;
      wb.setFromObject(o);
      wb.getCenter(wc);
      if (wc.z < 0) ring1Meshes.push(o);
      else ring2Meshes.push(o);
    });

    function frameVisible(keepAngle) {
      wrap.updateMatrixWorld(true);
      const visBox = new THREE.Box3();
      root.traverse((o) => {
        if (o.isMesh && o.visible) {
          visBox.expandByObject(o);
        }
      });
      if (visBox.isEmpty()) return;
      const vSize = visBox.getSize(new THREE.Vector3());
      const vCenter = visBox.getCenter(new THREE.Vector3());

      shadow.position.x = vCenter.x;
      shadow.position.z = vCenter.z;
      shadow.scale.set(vSize.x * 1.25, vSize.z * 1.25, 1);

      const radius = vSize.length() / 2 || 1;
      const target = new THREE.Vector3(vCenter.x, vBoxY(visBox, vSize), vCenter.z);
      const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
      const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
      const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 0.95;
      const dir = keepAngle
        ? camera.position.clone().sub(controls.target).normalize()
        : new THREE.Vector3(0.55, 0.45, 1).normalize();
      if (dir.lengthSq() < 1e-4) dir.set(0.55, 0.45, 1).normalize();
      home = {
        pos: target.clone().addScaledVector(new THREE.Vector3(0.55, 0.45, 1).normalize(), dist),
        target: target.clone(),
      };
      camera.position.copy(target).addScaledVector(dir, dist);
      controls.target.copy(target);
      controls.minDistance = dist * 0.25;
      controls.maxDistance = dist * 2.5;
      camera.near = dist / 100;
      camera.far = dist * 20;
      camera.updateProjectionMatrix();
      controls.update();
    }

    function vBoxY(b, s) {
      return b.min.y + s.y * 0.55;
    }

    function setRingFilter(modeKey) {
      for (const m of ring1Meshes) m.visible = modeKey === "both" || modeKey === "1";
      for (const m of ring2Meshes) m.visible = modeKey === "both" || modeKey === "2";
      document.querySelectorAll("[data-ring]").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.ring === modeKey));
      });
      frameVisible(false);
    }

    document.querySelectorAll("[data-ring]").forEach((b) => {
      b.addEventListener("click", () => setRingFilter(b.dataset.ring));
    });

    const initRing = params.get("ring");
    if (initRing === "1" || initRing === "2") {
      setRingFilter(initRing);
    } else {
      frameVisible(false);
    }
    loadingEl.classList.add("done");
  }

  function onProgress(ev) {
    if (ev && ev.total) {
      loadingEl.textContent = "Loading the model · " + Math.round((ev.loaded / ev.total) * 100) + "%";
    }
  }

  function onError(err) {
    loadingEl.textContent = "Protected preview · Valid access link required";
    loadingEl.classList.add("error");
    console.error(err);
  }

  if (product.encrypted) {
    const pinGate = document.getElementById("pinGate");
    const pinForm = document.getElementById("pinForm");
    const pinInput = document.getElementById("pinInput");
    const pinSubmit = document.getElementById("pinSubmit");
    const pinError = document.getElementById("pinError");
    let cachedEncryptedBytes = null;
    let fetchPromise = fetchEncryptedPayload(product.glb, onProgress).then((bytes) => {
      cachedEncryptedBytes = bytes;
      return bytes;
    });

    if (pinGate && pinForm && pinInput) {
      pinGate.hidden = false;
      setTimeout(() => pinInput.focus(), 50);
      pinForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pinVal = pinInput.value.trim();
        if (!pinVal) return;
        pinError.textContent = "";
        if (pinSubmit) {
          pinSubmit.disabled = true;
          pinSubmit.textContent = "Decrypting…";
        }
        try {
          const encBytes = cachedEncryptedBytes || (await fetchPromise);
          const decryptedBuffer = await decryptPayloadWithPin(encBytes, pinVal);
          pinGate.hidden = true;
          loadingEl.textContent = "Preparing 3D scene…";
          loader.parse(decryptedBuffer, "", onGltfLoaded, onError);
        } catch (err) {
          pinError.textContent = "Invalid PIN code. Please try again.";
          if (pinSubmit) {
            pinSubmit.disabled = false;
            pinSubmit.textContent = "Unlock 3D Model";
          }
          pinInput.select();
        }
      });
    } else {
      onError(new Error("PIN entry required"));
    }
  } else {
    loader.load(product.glb, onGltfLoaded, onProgress, onError);
  }

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
