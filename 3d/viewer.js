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
  const gemShaderMats = [];
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
    for (const gm of gemShaderMats) {
      gm.uniforms.tEnv.value = hdrEquirectTex;
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
    } else if (/rosegold/i.test(rp)) {
      const useYellow = product.glb === "prototip.bin" || product.glb === "prototiprender.glb";
      const col = useYellow ? METALS.yellow.color : METALS.rose.color;
      m.color.setRGB(...col, THREE.LinearSRGBColorSpace);
    } else if (/yellowgold/i.test(rp)) {
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

  function bakeGemNormalCaptureCube(geom) {
    geom.computeBoundingBox();
    const box = geom.boundingBox;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // WebGI squashFactor (0.98) + centerOffset toward table (+Z) for authentic pavilion bounce geometry
    const offsetCenter = new THREE.Vector3(center.x, center.y, center.z + size.z * 0.14);
    const invRadius = 2.0 / Math.max(size.x, size.y, size.z, 1e-4);

    const pos = geom.attributes.position;
    const idx = geom.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const tris = new Float32Array(triCount * 12);
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
      vA.fromBufferAttribute(pos, i0).sub(offsetCenter).multiplyScalar(invRadius);
      vB.fromBufferAttribute(pos, i1).sub(offsetCenter).multiplyScalar(invRadius);
      vC.fromBufferAttribute(pos, i2).sub(offsetCenter).multiplyScalar(invRadius);
      vA.z *= 0.98;
      vB.z *= 0.98;
      vC.z *= 0.98;
      e1.subVectors(vB, vA);
      e2.subVectors(vC, vA);
      n.crossVectors(e1, e2).normalize();
      const b = i * 12;
      tris[b] = vA.x; tris[b + 1] = vA.y; tris[b + 2] = vA.z;
      tris[b + 3] = e1.x; tris[b + 4] = e1.y; tris[b + 5] = e1.z;
      tris[b + 6] = e2.x; tris[b + 7] = e2.y; tris[b + 8] = e2.z;
      tris[b + 9] = n.x; tris[b + 10] = n.y; tris[b + 11] = n.z;
    }

    // Bake equirectangular normal-distance lookup map (256x128) from origin (0,0,0) outward in all directions
    const W = 256;
    const H = 128;
    const mapData = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const theta = ((y + 0.5) / H - 0.5) * Math.PI;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      for (let x = 0; x < W; x++) {
        const phi = ((x + 0.5) / W - 0.5) * 2.0 * Math.PI;
        const dx = cosT * Math.cos(phi);
        const dy = sinT;
        const dz = cosT * Math.sin(phi);

        let bestT = 1e9;
        let nx = dx, ny = dy, nz = dz;
        for (let i = 0; i < triCount; i++) {
          const b = i * 12;
          const v0x = tris[b], v0y = tris[b + 1], v0z = tris[b + 2];
          const e1x = tris[b + 3], e1y = tris[b + 4], e1z = tris[b + 5];
          const e2x = tris[b + 6], e2y = tris[b + 7], e2z = tris[b + 8];
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-7) continue;
          const invDet = 1.0 / det;
          const tx = -v0x, ty = -v0y, tz = -v0z;
          const u = (tx * px + ty * py + tz * pz) * invDet;
          if (u < 0.0 || u > 1.0) continue;
          const qx = ty * e1z - tz * e1y;
          const qy = tz * e1x - tx * e1z;
          const qz = tx * e1y - ty * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * invDet;
          if (v < 0.0 || u + v > 1.0) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
          if (t > 1e-4 && t < bestT) {
            bestT = t;
            nx = tris[b + 9];
            ny = tris[b + 10];
            nz = tris[b + 11];
            if (nx * dx + ny * dy + nz * dz < 0.0) {
              nx = -nx; ny = -ny; nz = -nz;
            }
          }
        }
        if (bestT > 1e8) bestT = 1.0;
        const idx4 = (y * W + x) * 4;
        mapData[idx4] = nx;
        mapData[idx4 + 1] = ny;
        mapData[idx4 + 2] = nz;
        mapData[idx4 + 3] = bestT;
      }
    }
    const captureTex = new THREE.DataTexture(mapData, W, H, THREE.RGBAFormat, THREE.FloatType);
    captureTex.magFilter = THREE.NearestFilter;
    captureTex.minFilter = THREE.NearestFilter;
    captureTex.wrapS = THREE.RepeatWrapping;
    captureTex.wrapT = THREE.ClampToEdgeWrapping;
    captureTex.needsUpdate = true;
    return { captureTex, offsetCenter, invRadius };
  }

  const gemCaptureCache = new WeakMap();

  function createGemMaterial(src, geom) {
    let cap = gemCaptureCache.get(geom);
    if (!cap) {
      cap = bakeGemNormalCaptureCube(geom);
      gemCaptureCache.set(geom, cap);
    }
    const rp = (src && src.userData && src.userData.rootPath) ? String(src.userData.rootPath) : "";
    const isEmerald = /emerald|green/i.test(rp);
    const isRuby = /ruby|red|garnet/i.test(rp);
    const isSapphire = /sapphire|blue/i.test(rp);

    // Match exact WebGI / iJewel 3D parameters from CUSHION_RING 005.glb & prototiprender.glb:
    // White Diamond: IOR=2.6, dispersion=0.012, absorption=1.0, color=#ffffff, reflectivity=0.5, envMapIntensity=1.3
    // Emerald (Gem 04): IOR=1.58, dispersion=0.003, absorption=1.8, color=#4fd553 (5232051), boost=(-0.3, 1.0, 1.0), reflectivity=0.31
    let gemColor = new THREE.Color(0xffffff);
    let ior = 2.6;
    let dispersion = 0.012;
    let absorption = 0.12;
    let reflectivity = 0.5;
    let envIntensity = 1.45;
    let boost = new THREE.Vector3(1.0, 1.0, 1.0);

    if (isEmerald) {
      gemColor.setHex(5232051);
      ior = 1.58;
      dispersion = 0.0025;
      absorption = 1.8;
      reflectivity = 0.31;
      envIntensity = 1.25;
      boost.set(0.7, 1.05, 1.0);
    } else if (isRuby) {
      gemColor.setHex(0xd91b42);
      ior = 1.77;
      dispersion = 0.004;
      absorption = 1.6;
      reflectivity = 0.38;
    } else if (isSapphire) {
      gemColor.setHex(0x1e4fd8);
      ior = 1.77;
      dispersion = 0.004;
      absorption = 1.6;
      reflectivity = 0.38;
    }

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tCapture: { value: cap.captureTex },
        tEnv: { value: hdrEquirectTex },
        uOffsetCenter: { value: cap.offsetCenter },
        uInvRadius: { value: cap.invRadius },
        uColor: { value: gemColor },
        uIor: { value: ior },
        uDispersion: { value: dispersion },
        uAbsorption: { value: absorption },
        uReflectivity: { value: reflectivity },
        uEnvIntensity: { value: envIntensity },
        uBoost: { value: boost },
      },
      vertexShader: `
        uniform vec3 uOffsetCenter;
        uniform float uInvRadius;
        varying vec3 vNormPos;
        varying vec3 vLocalNormal;
        varying vec3 vCamNormPos;
        varying mat3 vLocalToWorld;
        void main() {
          vec3 np = (position - uOffsetCenter) * uInvRadius;
          np.z *= 0.98;
          vNormPos = np;
          vLocalNormal = normalize(normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          mat4 invModel = inverse(modelMatrix);
          vec3 camLocal = (invModel * vec4(cameraPosition, 1.0)).xyz;
          vec3 cnp = (camLocal - uOffsetCenter) * uInvRadius;
          cnp.z *= 0.98;
          vCamNormPos = cnp;
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
        uniform sampler2D tCapture;
        uniform sampler2D tEnv;
        uniform vec3 uColor;
        uniform float uIor;
        uniform float uDispersion;
        uniform float uAbsorption;
        uniform float uReflectivity;
        uniform float uEnvIntensity;
        uniform vec3 uBoost;

        varying vec3 vNormPos;
        varying vec3 vLocalNormal;
        varying vec3 vCamNormPos;
        varying mat3 vLocalToWorld;

        const float PI = 3.14159265359;

        vec2 dirToUV(vec3 d) {
          vec3 n = normalize(d);
          return vec2(atan(n.z, n.x) / (2.0 * PI) + 0.5, asin(clamp(n.y, -1.0, 1.0)) / PI + 0.5);
        }

        vec4 sampleCapture(vec3 dir) {
          return texture2D(tCapture, dirToUV(dir));
        }

        vec3 sampleEnv(vec3 worldDir) {
          vec3 d = normalize(worldDir);
          // WebGI envMapRotationOffset (180 deg) + studio jeweler key lights
          vec2 uv = dirToUV(vec3(-d.x, d.y, -d.z));
          vec3 envCol = texture2D(tEnv, uv).rgb * uEnvIntensity;
          float s1 = pow(max(0.0, dot(d, normalize(vec3(0.32, 0.90, 0.28)))), 52.0) * 9.0;
          float s2 = pow(max(0.0, dot(d, normalize(vec3(-0.42, 0.84, -0.34)))), 44.0) * 7.5;
          float s3 = pow(max(0.0, dot(d, normalize(vec3(0.0, 0.97, -0.24)))), 68.0) * 11.0;
          return envCol + vec3(s1 + s2 + s3) * uEnvIntensity;
        }

        // Exact WebGI DiamondMaterial sphere-approximated normal capture raytracer (5 bounces, geometryFactor=0.5)
        vec3 traceWebGIGem(vec3 origin, vec3 initDir) {
          vec3 ior3 = vec3(uIor - uDispersion, uIor, uIor + uDispersion);
          vec3 invIor3 = 1.0 / ior3;
          vec3 result = vec3(0.0);

          for (int ch = 0; ch < 3; ch++) {
            float ior = ior3[ch];
            vec3 p = origin;
            vec3 d = initDir;
            float totalDist = 0.0;
            float throughput = 1.0;
            float chCol = 0.0;

            for (int b = 0; b < 5; b++) {
              // WebGI geometryFactor = 0.5 sphere-projected lookup direction
              vec3 lookupDir = normalize(p * 0.5 + d);
              vec4 cap = sampleCapture(lookupDir);
              vec3 nSurf = normalize(cap.xyz);
              float r = cap.w;

              // Ray distance inside capture volume
              float bDot = dot(p, d);
              float disc = max(0.0, bDot * bDot + r * r - dot(p, p));
              float stepDist = max(0.05, -bDot + sqrt(disc));
              totalDist += stepDist;
              p = normalize(p + d * stepDist * 0.5) * r;

              vec3 nIn = -nSurf;
              float cosI = clamp(dot(-d, nIn), 0.0, 1.0);
              float sinT2 = ior * ior * (1.0 - cosI * cosI);

              if (sinT2 >= 1.0) {
                d = reflect(d, nIn);
              } else {
                float cosT = sqrt(1.0 - sinT2);
                float r0 = (ior - 1.0) / (ior + 1.0);
                r0 = r0 * r0;
                float F = r0 + (1.0 - r0) * pow(1.0 - cosT, 5.0);
                vec3 refrLocal = refract(d, nIn, ior);
                vec3 envS = sampleEnv(vLocalToWorld * refrLocal);
                chCol += throughput * (1.0 - F) * envS[ch];
                throughput *= F;
                d = reflect(d, nIn);
                if (throughput < 0.03) break;
              }
            }
            if (throughput >= 0.03) {
              vec3 envS = sampleEnv(vLocalToWorld * d);
              chCol += throughput * envS[ch];
            }
            // Beer-Lambert gemstone color absorption
            vec3 absorbColor = max(vec3(0.02), uColor * uBoost);
            float atten = exp(-(1.0 - absorbColor[ch]) * totalDist * uAbsorption);
            result[ch] = chCol * atten;
          }
          return result;
        }

        void main() {
          vec3 dx = dFdx(vNormPos);
          vec3 dy = dFdy(vNormPos);
          vec3 flatN = normalize(cross(dx, dy));
          if (dot(flatN, vLocalNormal) < 0.0) flatN = -flatN;

          vec3 viewDir = normalize(vNormPos - vCamNormPos);
          float cosTheta = clamp(dot(-viewDir, flatN), 0.0, 1.0);
          float r0 = (1.0 - uIor) / (1.0 + uIor);
          r0 = r0 * r0 * (0.5 + uReflectivity);
          float F = clamp(r0 + (1.0 - r0) * pow(1.0 - cosTheta, 5.0), 0.0, 1.0);

          vec3 reflDir = reflect(viewDir, flatN);
          vec3 reflCol = sampleEnv(vLocalToWorld * reflDir);

          vec3 refrIn = refract(viewDir, flatN, 1.0 / uIor);
          if (length(refrIn) < 0.01) refrIn = reflDir;
          vec3 internalCol = traceWebGIGem(vNormPos, normalize(refrIn));

          vec3 finalColor = mix(internalCol, reflCol, F);
          gl_FragColor = vec4(finalColor, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    gemShaderMats.push(mat);
    return mat;
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
