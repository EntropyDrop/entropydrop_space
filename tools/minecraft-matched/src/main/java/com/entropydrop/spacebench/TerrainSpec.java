package com.entropydrop.spacebench;

import java.util.zip.CRC32;

/** Integer-only contract shared with MatchedTerrainSpec.ts; one cell is 1 m. */
public final class TerrainSpec {
    public static final int SIZE = 1024, SEED = 42, HEIGHT = 128;
    public static int hash(int x, int y, int z, int seed) {
        int h = x * 0x1f123bb5 ^ y * 0x5f356495 ^ z * 0x6c8e9cf5 ^ seed;
        h ^= h >>> 16; h *= 0x7feb352d; h ^= h >>> 15; h *= 0x846ca68b;
        return h ^ h >>> 16;
    }
    private static int noise(int x, int z, int step, int mask, int seed) {
        int gx = Math.floorDiv(x, step), gz = Math.floorDiv(z, step);
        int fx = Math.floorMod(x, step), fz = Math.floorMod(z, step);
        int a = (hash(gx, 0, gz, seed) & mask) * (step - fx) + (hash(gx + 1, 0, gz, seed) & mask) * fx;
        int b = (hash(gx, 0, gz + 1, seed) & mask) * (step - fx) + (hash(gx + 1, 0, gz + 1, seed) & mask) * fx;
        return (a * (step - fz) + b * fz) / (step * step);
    }
    public static int height(int x, int z, int seed) {
        if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return -1;
        return 8 + noise(x, z, 64, 63, seed) + noise(x, z, 16, 15, seed ^ 0x13579bdf);
    }
    public static int colorIndex(int x, int y, int z, int seed) { return hash(x, y, z, seed ^ 0x2468ace0) >>> 24; }
    public static int rgb(int index) { return 0x404040 + (hash(index, 0, 0, 0x31415926) & 0x7f7f7f); }
    public static void main(String[] args) {
        CRC32 crc = new CRC32(); long solid = 0;
        // Canonical stream: z, x, column height+1 (u8), then RGB for y=0..height.
        for (int z = 0; z < SIZE; z++) for (int x = 0; x < SIZE; x++) {
            int top = height(x, z, SEED); crc.update(top + 1);
            for (int y = 0; y <= top; y++) {
                int rgb = rgb(colorIndex(x, y, z, SEED));
                crc.update(rgb >>> 16); crc.update(rgb >>> 8); crc.update(rgb); solid++;
            }
        }
        System.out.printf("{\"size\":%d,\"seed\":%d,\"solidBlocks\":%d,\"crc32\":\"%08x\"}%n", SIZE, SEED, solid, crc.getValue());
    }
}
