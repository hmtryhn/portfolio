import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
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

  // Studio light: studio_1k.hdr for balanced metal reflections + iJewel env-gem-002.exr exclusively for diamonds/gems
  const pmrem = new THREE.PMREMGenerator(renderer);
  const gemShaderMats = [];
  let gemEnvTex = null;

  new RGBELoader().load("studio_1k.hdr", (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const envScene = new THREE.Scene();
    envScene.background = tex;
    scene.environment = pmrem.fromScene(envScene, 0.016).texture;
    tex.dispose();
  });

  new EXRLoader().load("env-gem-002.exr", (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    gemEnvTex = tex;
    for (const gm of gemShaderMats) {
      gm.uniforms.envMap.value = gemEnvTex;
    }
  });

  const metalMats = [];
  let activeMetal = METALS[product.defaultMetal] ? product.defaultMetal : "yellow";

  function createMetalMaterial(src, preserveInitialColor) {
    const m = new THREE.MeshPhysicalMaterial({
      metalness: 1,
      roughness: 0.055,
      envMapIntensity: 0.95,
      side: THREE.DoubleSide,
    });
    const rp = (src && src.userData && src.userData.rootPath) ? String(src.userData.rootPath) : "";
    if (/whitegold|silver|platinum/i.test(rp)) {
      m.color.setRGB(...METALS.white.color, THREE.LinearSRGBColorSpace);
    } else if (/warmgold|yellowgold/i.test(rp)) {
      m.color.setRGB(...METALS.yellow.color, THREE.LinearSRGBColorSpace);
    } else if (/rosegold/i.test(rp)) {
      const useYellow = product.glb === "prototip.bin" || product.glb === "prototiprender.glb";
      const col = useYellow ? METALS.yellow.color : METALS.rose.color;
      m.color.setRGB(...col, THREE.LinearSRGBColorSpace);
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

  // Exact WebGI / iJewel 3D Normal-Distance CubeMap capture ($c capture shader + CubeCamera)
  const normalCaptureMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      radius: { value: 1.0 },
      offsetMatrixInv: { value: new THREE.Matrix4() },
      offsetCenter: { value: new THREE.Vector3() },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vecPosition;
      uniform mat4 offsetMatrixInv;
      uniform vec3 offsetCenter;
      void main() {
        vNormal = normalize((offsetMatrixInv * vec4(normal, 0.0)).xyz);
        vec3 transformed = position - offsetCenter;
        vec4 offsetPos = offsetMatrixInv * vec4(transformed, 1.0);
        vecPosition = (modelMatrix * offsetPos).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * offsetPos;
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      varying vec3 vecPosition;
      uniform float radius;
      void main() {
        vec3 color = normalize(vNormal) * 0.5 + 0.5;
        gl_FragColor = vec4(color.x, color.y, color.z, length(vecPosition) / radius);
      }
    `,
  });

  const gemCaptureCache = new WeakMap();

  function captureWebGINormalCube(geom) {
    let cached = gemCaptureCache.get(geom);
    if (cached) return cached;

    const offsets = (geom.userData && geom.userData.normalsCaptureOffsets) || {};
    const center = offsets.center ? new THREE.Vector3().fromArray(offsets.center) : new THREE.Vector3(0, 0, -1.3547);
    const centerOffset = offsets.centerOffset ? new THREE.Vector3().fromArray(offsets.centerOffset) : new THREE.Vector3(0, 0, 0.2595);
    const radius = typeof offsets.radius === "number" ? offsets.radius : 1.0;
    const offsetMatrix = offsets.offsetMatrix ? new THREE.Matrix4().fromArray(offsets.offsetMatrix) : new THREE.Matrix4().makeScale(5.2195, 5.2195, -5.2195);
    const offsetMatrixInv = offsets.offsetMatrixInv ? new THREE.Matrix4().fromArray(offsets.offsetMatrixInv) : offsetMatrix.clone().invert();

    const cubeRT = new THREE.WebGLCubeRenderTarget(512, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    const cubeCam = new THREE.CubeCamera(1e-4, 100, cubeRT);
    const capScene = new THREE.Scene();
    const capMesh = new THREE.Mesh(geom, normalCaptureMat);
    capMesh.frustumCulled = false;
    capScene.add(capMesh);
    capScene.add(cubeCam);

    normalCaptureMat.uniforms.offsetCenter.value.copy(center);
    normalCaptureMat.uniforms.offsetMatrixInv.value.copy(offsetMatrixInv);
    normalCaptureMat.uniforms.radius.value = radius;

    const oldAutoClear = renderer.autoClear;
    const oldToneMapping = renderer.toneMapping;
    const oldColorSpace = renderer.outputColorSpace;
    const oldClearColor = renderer.getClearColor(new THREE.Color());
    const oldClearAlpha = renderer.getClearAlpha();

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    cubeCam.update(renderer, capScene);

    renderer.setClearColor(oldClearColor, oldClearAlpha);
    renderer.toneMapping = oldToneMapping;
    renderer.outputColorSpace = oldColorSpace;
    renderer.autoClear = oldAutoClear;

    cached = {
      cubeTex: cubeRT.texture,
      center,
      centerOffset,
      radius,
      offsetMatrix,
      offsetMatrixInv,
    };
    gemCaptureCache.set(geom, cached);
    return cached;
  }

  function createGemMaterial(src, geom) {
    const cap = captureWebGINormalCube(geom);
    const rp = (src && src.userData && src.userData.rootPath) ? String(src.userData.rootPath) : "";
    const isEmerald = /emerald|green/i.test(rp);

    // Exact WebGI DiamondMaterial parameters from CUSHION_RING 005.glb & prototiprender.glb
    const color = isEmerald ? new THREE.Color(5232051) : new THREE.Color(16777215);
    const envMapIntensity = isEmerald ? 1.0 : 1.3;
    const refractiveIndex = isEmerald ? 1.58 : 2.6;
    const rIndexDelta = isEmerald ? 0.0 : 0.01;
    const squashFactor = 0.98;
    const geometryFactor = 0.5;
    const gammaFactor = 1.0;
    const absorptionFactor = isEmerald ? 1.8 : 1.0;
    const reflectivity = isEmerald ? 0.31 : 0.5;
    const boostFactors = isEmerald ? new THREE.Vector3(-0.3, 1.0, 1.0) : new THREE.Vector3(1.0, 1.0, 1.0);

    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: {
        tCubeMapNormals: { value: cap.cubeTex },
        envMap: { value: gemEnvTex },
        radius: { value: cap.radius },
        centerOffset: { value: cap.centerOffset.clone() },
        modelOffsetMatrix: { value: new THREE.Matrix4() },
        modelOffsetMatrixInv: { value: new THREE.Matrix4() },
        envMapIntensity: { value: envMapIntensity },
        refractiveIndex: { value: refractiveIndex },
        rIndexDelta: { value: rIndexDelta },
        squashFactor: { value: squashFactor },
        geometryFactor: { value: geometryFactor },
        color: { value: color },
        colorCorrection: { value: new THREE.Vector3(1, 1, 1) },
        boostFactors: { value: boostFactors },
        gammaFactor: { value: gammaFactor },
        absorptionFactor: { value: absorptionFactor },
        envMapRotation: { value: 0.0 },
        envMapRotationQuat: { value: new THREE.Vector4(0, 0, 0, 1) },
        reflectivity: { value: reflectivity },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        varying vec3 vViewPosition;
        varying vec3 vNormal;
        void main() {
          vWorldNormal = (modelMatrix * vec4(normal, 0.0)).xyz;
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -mvPosition.xyz;
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPosition;
        varying vec3 vViewPosition;
        varying vec3 vNormal;

        uniform float radius;
        uniform vec3 centerOffset;
        uniform mat4 modelOffsetMatrixInv;
        uniform mat4 modelOffsetMatrix;
        uniform samplerCube tCubeMapNormals;
        uniform sampler2D envMap;
        uniform float envMapIntensity;
        uniform float refractiveIndex;
        uniform float rIndexDelta;
        uniform float squashFactor;
        uniform float geometryFactor;
        uniform vec3 color;
        uniform vec3 colorCorrection;
        uniform vec3 boostFactors;
        uniform float gammaFactor;
        uniform float absorptionFactor;
        uniform float envMapRotation;
        uniform vec4 envMapRotationQuat;
        uniform float reflectivity;

        #define PI 3.1428
        #define RAY_BOUNCES 5
        #define CENTER_OFFSET (centerOffset)
        #define MODEL_OFFSET_MATRIX modelOffsetMatrix
        #define INV_MODEL_OFFSET_MATRIX modelOffsetMatrixInv

        vec3 BRDF_Specular_GGX_Environment(const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float roughness) {
          float dotNV = abs(dot(normal, viewDir));
          const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
          const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
          vec4 r = roughness * c0 + c1;
          float a004 = min(r.x * r.x, exp2(-9.28 * dotNV)) * r.x + r.y;
          vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
          return specularColor * AB.x + AB.y;
        }

        vec2 cartesianToPolar(vec3 n) {
          vec2 uv;
          uv.x = atan(n.z, n.x) / (PI * 2.0) + 0.5;
          uv.y = asin(clamp(n.y, -1.0, 1.0)) / PI + 0.5;
          return uv;
        }

        vec4 sampleEnvMap(vec3 direction, float roughness) {
          float cs = cos(envMapRotation);
          float sn = sin(envMapRotation);
          float temp = cs * direction.x + sn * direction.z;
          direction.z = -sn * direction.x + cs * direction.z;
          direction.x = temp;
          direction.x *= -1.0;
          direction.y *= -1.0;
          direction.z *= -1.0;
          vec3 t = 2.0 * cross(envMapRotationQuat.xyz, direction);
          direction += envMapRotationQuat.w * t + cross(envMapRotationQuat.xyz, t);
          return texture2D(envMap, cartesianToPolar(normalize(direction)));
        }

        vec4 SampleSpecularReflection(vec3 direction, float roughness) {
          direction = (viewMatrix * vec4(direction, 0.0)).xyz;
          return envMapIntensity * sampleEnvMap(direction, roughness);
        }

        vec4 SampleSpecularContribution(vec3 direction, float roughness) {
          direction = mat3(MODEL_OFFSET_MATRIX) * direction;
          direction = (viewMatrix * vec4(direction, 0.0)).xyz;
          direction = normalize(direction);
          direction.x *= -1.0;
          direction.z *= -1.0;
          return envMapIntensity * sampleEnvMap(direction, roughness);
        }

        vec3 intersectSphere(vec3 origin, vec3 direction) {
          origin -= CENTER_OFFSET;
          direction.y /= squashFactor;
          float A = dot(direction, direction);
          float B = 2.0 * dot(origin, direction);
          float C = dot(origin, origin) - radius * radius;
          float disc = B * B - 4.0 * A * C;
          if (disc > 0.0) {
            disc = sqrt(disc);
            float t1 = (-B + disc) * geometryFactor / A;
            float t2 = (-B - disc) * geometryFactor / A;
            float t = (t1 > t2) ? t1 : t2;
            direction.y *= squashFactor;
            return vec3(origin + CENTER_OFFSET + direction * t);
          }
          return vec3(0.0);
        }

        vec3 linePlaneIntersect(in vec3 pointOnLine, in vec3 lineDirection, in vec3 pointOnPlane, in vec3 planeNormal) {
          return lineDirection * (dot(planeNormal, pointOnPlane - pointOnLine) / dot(planeNormal, lineDirection)) + pointOnLine;
        }

        vec4 getNormalDistance(vec3 d) {
          return textureCube(tCubeMapNormals, d);
        }

        vec3 getSurfaceNormal(vec4 surfaceInfos) {
          vec3 surfaceNormal = surfaceInfos.rgb;
          surfaceNormal = surfaceNormal * 2.0 - 1.0;
          return -normalize(surfaceNormal);
        }

        vec3 intersect(vec3 rayOrigin, vec3 rayDirection, inout vec3 hitNormal) {
          vec3 sphereHitPoint = intersectSphere(rayOrigin, rayDirection);
          vec3 direction1 = normalize(sphereHitPoint - CENTER_OFFSET);
          vec4 normalDistanceData1 = getNormalDistance(direction1);
          float distance1 = normalDistanceData1.a * radius;
          vec3 pointOnPlane1 = CENTER_OFFSET + direction1 * distance1;
          vec3 planeNormal1 = getSurfaceNormal(normalDistanceData1);
          vec3 hitPoint1 = linePlaneIntersect(rayOrigin, rayDirection, pointOnPlane1, planeNormal1);

          vec3 direction2 = normalize(hitPoint1 - CENTER_OFFSET);
          vec4 normalDistanceData2 = getNormalDistance(direction2);
          float distance2 = normalDistanceData2.a * radius;
          vec3 pointOnPlane2 = CENTER_OFFSET + direction2 * distance2;
          vec3 planeNormal2 = getSurfaceNormal(normalDistanceData2);
          hitNormal = planeNormal2;
          vec3 hitPoint = linePlaneIntersect(rayOrigin, rayDirection, pointOnPlane2, planeNormal2);
          return hitPoint;
        }

        vec3 getRefractionColor(vec3 origin, vec3 direction, vec3 normal) {
          vec3 outColor = vec3(0.0);
          const float n1 = 1.0;
          const float epsilon = 1e-4;
          float f0 = (2.4 - n1) / (2.4 + n1);
          f0 *= f0;
          vec3 attenuationFactor = vec3(1.0);
          vec3 newDirection = refract(direction, normal, n1 / refractiveIndex);
          vec3 brdfRefracted = BRDF_Specular_GGX_Environment(newDirection, -normal, vec3(f0), 0.0);
          attenuationFactor *= (vec3(1.0) - brdfRefracted);
          mat4 invModelOffsetMatrix = INV_MODEL_OFFSET_MATRIX;
          newDirection = normalize((invModelOffsetMatrix * vec4(newDirection, 0.0)).xyz);
          origin = (invModelOffsetMatrix * vec4(origin, 1.0)).xyz;

          for (int i = 0; i < RAY_BOUNCES; i++) {
            vec3 hitNormal;
            vec3 intersectedPos = intersect(origin, newDirection, hitNormal);
            vec3 dist = intersectedPos - origin;
            vec3 d = normalize(intersectedPos - CENTER_OFFSET);
            vec3 mappedNormal = getNormalDistance(d).rgb;
            mappedNormal = 2.0 * mappedNormal - 1.0;
            mappedNormal = -normalize(mappedNormal);
            float r = length(dist) / radius * absorptionFactor;
            attenuationFactor *= exp(-r * (1.0 - color));
            origin = intersectedPos;
            vec3 oldDir = newDirection;
            newDirection = refract(newDirection, mappedNormal, refractiveIndex / n1);

            if (dot(newDirection, newDirection) < epsilon) {
              newDirection = reflect(oldDir, mappedNormal);
              if (i == RAY_BOUNCES - 1) {
                vec3 brdfReflected = BRDF_Specular_GGX_Environment(-oldDir, mappedNormal, vec3(f0), 0.0);
                outColor += SampleSpecularContribution(oldDir, 0.0).rgb * attenuationFactor * colorCorrection * boostFactors * (vec3(1.0) - min(vec3(1.0), brdfReflected));
              }
            } else {
              vec3 brdfRefracted2 = vec3(1.0) - min(vec3(1.0), BRDF_Specular_GGX_Environment(newDirection, -mappedNormal, vec3(f0), 0.0));
              vec3 dir0 = newDirection;
              vec3 dir1 = refract(oldDir, mappedNormal, (refractiveIndex + rIndexDelta) / n1);
              vec3 dir2 = refract(oldDir, mappedNormal, (refractiveIndex - rIndexDelta) / n1);
              vec3 specRefColor = vec3(
                SampleSpecularContribution(dir1, 0.0).r,
                SampleSpecularContribution(dir0, 0.0).g,
                SampleSpecularContribution(dir2, 0.0).b
              ) * brdfRefracted2 * attenuationFactor * colorCorrection * boostFactors;
              outColor += specRefColor;
              newDirection = reflect(oldDir, mappedNormal);
              vec3 brdfReflected = BRDF_Specular_GGX_Environment(newDirection, mappedNormal, vec3(f0), 0.0);
              attenuationFactor *= brdfReflected * boostFactors;
            }
          }
          return outColor;
        }

        void main() {
          vec3 normalizedNormal = normalize(vWorldNormal);
          vec3 viewVector = normalize(vWorldPosition - cameraPosition);
          const float n1 = 1.0;
          float f0 = (2.4 - n1) / (2.4 + n1);
          f0 *= f0;
          vec3 reflectedDirection = reflect(viewVector, normalizedNormal);
          vec3 brdfReflected = BRDF_Specular_GGX_Environment(reflectedDirection, normalizedNormal, vec3(f0), 0.0);
          vec3 reflectionColor = SampleSpecularReflection(reflectedDirection, 0.0).rgb * brdfReflected * reflectivity * 2.0;
          vec3 refractionColor = getRefractionColor(vWorldPosition, viewVector, normalizedNormal);
          gl_FragColor = vec4(refractionColor.rgb + reflectionColor.rgb, 1.0);
          gl_FragColor.rgb = pow(max(gl_FragColor.rgb, 0.0), vec3(gammaFactor));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    mat.userData._cap = cap;
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
        let gm = gemBySrc.get(o.geometry);
        if (!gm) {
          gm = createGemMaterial(src, o.geometry);
          gemBySrc.set(o.geometry, gm);
        }
        // Clone per mesh instance so each gem's exact world transform (modelOffsetMatrix) is uploaded in onBeforeRender
        const instMat = gm.clone();
        instMat.uniforms = THREE.UniformsUtils.clone(gm.uniforms);
        instMat.uniforms.tCubeMapNormals.value = gm.userData._cap.cubeTex;
        instMat.uniforms.envMap.value = gemEnvTex;
        const cap = gm.userData._cap;
        gemShaderMats.push(instMat);
        o.material = instMat;
        o.onBeforeRender = function () {
          instMat.uniforms.modelOffsetMatrix.value.copy(cap.offsetMatrix).premultiply(o.matrixWorld);
          instMat.uniforms.modelOffsetMatrixInv.value.copy(instMat.uniforms.modelOffsetMatrix.value).invert();
        };
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
    const meshCenters = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      wb.setFromObject(o);
      wb.getCenter(wc);
      meshCenters.push({ mesh: o, x: wc.x, z: wc.z });
    });
    if (meshCenters.length > 0) {
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const mc of meshCenters) {
        if (mc.x < minX) minX = mc.x;
        if (mc.x > maxX) maxX = mc.x;
        if (mc.z < minZ) minZ = mc.z;
        if (mc.z > maxZ) maxZ = mc.z;
      }
      const splitByX = (maxX - minX) >= (maxZ - minZ);
      const mid = splitByX ? (minX + maxX) * 0.5 : (minZ + maxZ) * 0.5;
      for (const mc of meshCenters) {
        const val = splitByX ? mc.x : mc.z;
        if (val < mid) ring1Meshes.push(mc.mesh);
        else ring2Meshes.push(mc.mesh);
      }
    }

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
