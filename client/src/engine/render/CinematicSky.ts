/** Procedural sky in local surface coordinates, shared by both world shapes. */
export const CINEMATIC_SKY_GLSL = /* glsl */ `
  float cloudHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float cloudNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(cloudHash(cell), cloudHash(cell + vec2(1.0, 0.0)), f.x),
      mix(cloudHash(cell + vec2(0.0, 1.0)), cloudHash(cell + vec2(1.0)), f.x), f.y);
  }
  float cloudFbm(vec2 p) {
    float value = 0.0;
    float weight = 0.5;
    for (int i = 0; i < 5; i++) {
      value += cloudNoise(p) * weight;
      p = mat2(1.6, -1.2, 1.2, 1.6) * p + vec2(11.3, 7.1);
      weight *= 0.5;
    }
    return value;
  }
  vec3 cinematicSky(vec3 dir, vec3 up, vec3 east, vec3 north, vec3 sun, float time) {
    float height = dot(dir, up);
    float sunDot = max(dot(dir, sun), 0.0);
    // Deep blue zenith, luminous horizon and a warm Mie-scattering aureole.
    vec3 horizon = vec3(0.35, 0.58, 0.94);
    vec3 zenith = vec3(0.018, 0.09, 0.34);
    vec3 color = mix(horizon, zenith, pow(max(height, 0.0), 0.45));
    color += vec3(1.0, 0.56, 0.22) * pow(sunDot, 8.0) * 0.26;
    color += vec3(1.0, 0.69, 0.35) * pow(sunDot, 96.0) * 1.35;
    float disc = smoothstep(0.99945, 0.99978, sunDot);
    color += vec3(1.0, 0.86, 0.59) * disc * 12.0;

    if (height > 0.015) {
      vec2 wind = vec2(time * 0.008, time * 0.003);
      vec2 cloudUv = vec2(dot(dir, east), dot(dir, north)) / max(height, 0.015) * 1.65 + wind;
      float broadShape = cloudNoise(cloudUv * 0.42 + 13.0);
      float density = cloudFbm(cloudUv) * 0.78 + broadShape * 0.22;
      float cloud = smoothstep(0.48, 0.69, density);
      cloud *= smoothstep(0.08, 0.24, height);
      vec2 lightOffset = vec2(dot(sun, east), dot(sun, north)) * 0.16;
      float litDensity = cloudFbm(cloudUv + lightOffset) * 0.78 + broadShape * 0.22;
      float silverLining = clamp((density - litDensity) * 7.0 + 0.35, 0.0, 1.0);
      vec3 cloudColor = mix(vec3(0.38, 0.49, 0.65), vec3(1.3, 1.26, 1.16), silverLining);
      cloudColor += vec3(1.0, 0.69, 0.36) * pow(sunDot, 16.0) * (1.0 - cloud) * 0.8;
      color = mix(color, cloudColor, cloud * 0.96);
      // Wispy upper cloud sheet moves at a different speed.
      float wisps = smoothstep(0.62, 0.79, cloudFbm(cloudUv * vec2(0.5, 2.4) + wind * 0.6 + 29.0));
      color = mix(color, vec3(1.25, 1.3, 1.4), wisps * 0.22 * smoothstep(0.08, 0.3, height));
    }
    return color;
  }
`;
