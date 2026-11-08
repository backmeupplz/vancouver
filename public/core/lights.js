// Night lights: the street lamps and the storefronts' spill that the tile worker places (tile-worker.js lights()).
// Not thousands of real lights: each is a soft disc drawn from above into one small texture over what is on screen
// (red: lamps, green: shops), redrawn only when the view moves past it or tiles come and go, and the ground, road
// and building materials look their light up there (materials.js streetLight). The lamps' heads glow as sprites
// drawn after the ink pass, depth-tested against the city so buildings hide them.
import * as THREE from 'three'
import { streetLight, night } from './materials.js'

const POOL = [12, 6] // the most a lamp's pool reaches (its brightness sets 8 to 12 m) and a shop window's spill, metres
const HEAD = 6.5 // lamp head height

export class StreetLights {
  constructor() {
    this.scene = new THREE.Scene() // the discs, one mesh per detail tile (Tiles adds them)
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2e4)
    this.cam.up.set(0, 0, -1) // screen right = east, up = north: the texture's u, v (materials.js poolLight)
    this.size = 2048
    this.rt = null
    this.quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2) // in x, z
    this.sprite = new THREE.PlaneGeometry(2, 2)
    this.pool = new THREE.ShaderMaterial({
      uniforms: { lamps: { value: 0 } },
      vertexShader: `attribute vec4 iPos; varying vec2 vQ; varying float vShop, vI;
        uniform float lamps;
        void main() {
          vShop = float(gl_InstanceID) >= lamps ? 1.0 : 0.0; vQ = position.xz; vI = iPos.w;
          vec3 p = iPos.xyz + position * (vShop > 0.5 ? ${POOL[1].toFixed(1)} : ${POOL[0].toFixed(1)} * (0.55 + 0.45 * iPos.w));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p.x, 0.0, p.z, 1.0);
        }`,
      fragmentShader: `varying vec2 vQ; varying float vShop, vI;
        void main() { float d = exp(-4.0 * dot(vQ, vQ)) * (1.0 - smoothstep(0.7, 1.0, length(vQ))) * vI; gl_FragColor = vec4(vShop > 0.5 ? vec2(0.0, d * 0.35) : vec2(d * 0.7, 0.0), 0.0, 1.0); } // a soft gaussian, gone at the rim`,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    })
    this.head = new THREE.ShaderMaterial({ // the lamps' heads: a bright point in a soft halo
      uniforms: { night },
      vertexShader: `attribute vec4 iPos; varying vec2 vQ;
        void main() { vQ = position.xy; vec4 mv = modelViewMatrix * vec4(iPos.xyz + vec3(0.0, ${HEAD.toFixed(1)}, 0.0), 1.0); mv.xy += position.xy * (1.4 + 0.8 * iPos.w); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float night; varying vec2 vQ;
        void main() { float r = length(vQ); float a = exp(-r * r * 9.0) * 0.55 + smoothstep(0.2, 0.08, r) * 0.9; if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(1.0, 0.82, 0.58) * a * night, 1.0);
          #include <colorspace_fragment>
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    })
  }

  // a tile's lights (tile-worker.js lights()) -> { pool, head }: the discs (this.scene) and the lamp heads (to draw
  // with the trees), both at the tile's corner
  meshes(t, L, at) {
    const geo = (base, n) => {
      const g = new THREE.InstancedBufferGeometry().copy(base)
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(L.pos, 4)); g.instanceCount = n
      g.boundingBox = new THREE.Box3(new THREE.Vector3().fromArray(L.box), new THREE.Vector3().fromArray(L.box, 3)).expandByScalar(POOL[0] + HEAD)
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
      return g
    }
    const mk = (g, mat) => { const m = new THREE.Mesh(g, mat); m.position.copy(at); m.matrixAutoUpdate = false; m.updateMatrix(); return m }
    const pool = mk(geo(this.quad, L.pos.length / 4), this.pool)
    pool.onBeforeRender = () => { this.pool.uniforms.lamps.value = L.lamps; this.pool.uniformsNeedUpdate = true }
    const head = L.lamps ? mk(geo(this.sprite, L.lamps), this.head) : null
    return { pool, head }
  }

  // the texture over the square of half-size r around (x, z): drawn when night falls, the square moves or tiles change
  draw(renderer, x, z, r, size) {
    if (!this.rt || this.size !== size) {
      this.rt?.dispose(); this.size = size
      this.rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
      streetLight.map.value = this.rt.texture
    }
    const c = this.cam
    Object.assign(c, { left: -r, right: r, top: r, bottom: -r }); c.updateProjectionMatrix()
    c.position.set(x, 1e4, z); c.lookAt(x, 0, z); c.updateMatrixWorld()
    const keep = renderer.getRenderTarget(), cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha()
    renderer.setRenderTarget(this.rt); renderer.setClearColor(0, 0); renderer.clear()
    renderer.render(this.scene, c)
    renderer.setRenderTarget(keep); renderer.setClearColor(cc, ca)
    streetLight.box.value.set(x - r, z + r, 1 / (2 * r), 1)
  }

  off() { streetLight.box.value.w = 0 }
}
