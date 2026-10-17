import { Vector2 } from 'three';

// Wind sway for foliage materials (works with InstancedMesh: phase varies per tree).
export const swayUniforms = { uTime: { value: 0 }, uWind: { value: new Vector2() } };

export function applySway(material) {
  if (!material || material.userData.sway) return;
  material.userData.sway = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = swayUniforms.uTime;
    shader.uniforms.uWind = swayUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 swayP = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 swayP = vec3(0.0);
        #endif
        float swayH = clamp(position.y + 0.6, 0.0, 1.6);
        float swayPh = swayP.x * 0.37 + swayP.z * 0.23;
        float swayS = sin(uTime * 1.7 + swayPh) * 0.6 + sin(uTime * 3.1 + swayPh * 1.9) * 0.4;
        float swayA = min(length(uWind), 14.0);
        transformed.xz += (uWind * 0.006 + normalize(uWind + vec2(1e-4)) * swayA * 0.012 * swayS) * swayH;
      `);
  };
  material.customProgramCacheKey = () => 'dronosim-sway';
  material.needsUpdate = true;
}
