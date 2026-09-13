import * as THREE from 'three';

export class ParticleSystem {
  private scene: THREE.Scene;
  private particles: any[] = [];
  private maxParticles = 600;
  private geometry: THREE.BoxGeometry;
  private material: THREE.MeshBasicMaterial;
  private instancedMesh: THREE.InstancedMesh;
  private dummy: THREE.Object3D;

  constructor(scene: any) {
    this.scene = scene;
    this.particles = [];
    this.maxParticles = 600;

    // Geometry & Material
    this.geometry = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9
    });

    this.instancedMesh = new THREE.InstancedMesh(this.geometry, this.material, this.maxParticles);
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.maxParticles * 3), 3);
    this.instancedMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this.dummy = new THREE.Object3D();
    this.scene.add(this.instancedMesh);

    // Initialize all hidden
    for (let i = 0; i < this.maxParticles; i++) {
      this.dummy.position.set(0, -999, 0);
      this.dummy.scale.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  emitSteamPuff(worldPos, count = 15) {
    for (let i = 0; i < count; i++) {
      this.spawnParticle({
        x: worldPos.x + (Math.random() - 0.5) * 0.8,
        y: worldPos.y + (Math.random() - 0.5) * 0.5,
        z: worldPos.z + (Math.random() - 0.5) * 0.8,
        vx: (Math.random() - 0.5) * 1.5,
        vy: 1.5 + Math.random() * 2.0,
        vz: (Math.random() - 0.5) * 1.5,
        size: 0.25 + Math.random() * 0.35,
        color: new THREE.Color(0xf1f2f6),
        life: 0.8 + Math.random() * 0.5,
        gravity: -0.5
      });
    }
  }

  emitBlockBreak(worldPos, hexColor, count = 12) {
    const color = new THREE.Color(hexColor);
    for (let i = 0; i < count; i++) {
      this.spawnParticle({
        x: worldPos.x + (Math.random() - 0.5) * 0.7,
        y: worldPos.y + (Math.random() - 0.5) * 0.7,
        z: worldPos.z + (Math.random() - 0.5) * 0.7,
        vx: (Math.random() - 0.5) * 3.5,
        vy: 2.0 + Math.random() * 3.0,
        vz: (Math.random() - 0.5) * 3.5,
        size: 0.15 + Math.random() * 0.15,
        color: color,
        life: 0.6 + Math.random() * 0.4,
        gravity: -16.0
      });
    }
  }

  spawnParticle(config) {
    if (this.particles.length >= this.maxParticles) {
      this.particles.shift(); // remove oldest
    }
    this.particles.push({
      x: config.x,
      y: config.y,
      z: config.z,
      vx: config.vx,
      vy: config.vy,
      vz: config.vz,
      size: config.size,
      maxLife: config.life,
      life: config.life,
      color: config.color,
      gravity: config.gravity !== undefined ? config.gravity : -9.8
    });
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }

    // Update instanced mesh
    for (let i = 0; i < this.maxParticles; i++) {
      if (i < this.particles.length) {
        const p = this.particles[i];
        const progress = p.life / p.maxLife;
        const currentScale = p.size * progress;

        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.scale.set(currentScale, currentScale, currentScale);
        this.dummy.updateMatrix();

        this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
        this.instancedMesh.setColorAt(i, p.color);
      } else {
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
      }
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
  }
}
