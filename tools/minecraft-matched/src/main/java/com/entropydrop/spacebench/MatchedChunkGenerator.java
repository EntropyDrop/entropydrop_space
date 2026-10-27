package com.entropydrop.spacebench;

import com.mojang.serialization.Codec;
import com.mojang.serialization.MapCodec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.registry.entry.RegistryEntry;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.ChunkRegion;
import net.minecraft.world.HeightLimitView;
import net.minecraft.world.Heightmap;
import net.minecraft.world.StructureWorldAccess;
import net.minecraft.world.biome.Biome;
import net.minecraft.world.biome.source.BiomeAccess;
import net.minecraft.world.biome.source.FixedBiomeSource;
import net.minecraft.world.chunk.Chunk;
import net.minecraft.world.gen.GenerationStep;
import net.minecraft.world.gen.StructureAccessor;
import net.minecraft.world.gen.chunk.ChunkGenerator;
import net.minecraft.world.gen.chunk.Blender;
import net.minecraft.world.gen.chunk.VerticalBlockSample;
import net.minecraft.world.gen.noise.NoiseConfig;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** No vanilla structures, decoration, fluids, caves, or entity generation. */
public final class MatchedChunkGenerator extends ChunkGenerator {
    public static final MapCodec<MatchedChunkGenerator> CODEC = RecordCodecBuilder.mapCodec(i -> i.group(
        Biome.REGISTRY_CODEC.fieldOf("biome").forGetter(g -> g.biome),
        Codec.INT.fieldOf("seed").orElse(TerrainSpec.SEED).forGetter(g -> g.seed)
    ).apply(i, MatchedChunkGenerator::new));
    private final RegistryEntry<Biome> biome;
    private final int seed;
    public MatchedChunkGenerator(RegistryEntry<Biome> biome, int seed) { super(new FixedBiomeSource(biome)); this.biome = biome; this.seed = seed; }
    @Override protected MapCodec<? extends ChunkGenerator> getCodec() { return CODEC; }
    @Override public CompletableFuture<Chunk> populateNoise(Blender blender, NoiseConfig noise, StructureAccessor structures, Chunk chunk) {
        BlockPos.Mutable pos = new BlockPos.Mutable();
        for (int z = chunk.getPos().getStartZ(); z <= chunk.getPos().getEndZ(); z++)
            for (int x = chunk.getPos().getStartX(); x <= chunk.getPos().getEndX(); x++)
                for (int y = 0, h = TerrainSpec.height(x, z, seed); y <= h; y++)
                    chunk.setBlockState(pos.set(x, y, z), SpaceMatched.BLOCKS[TerrainSpec.colorIndex(x, y, z, seed)].getDefaultState(), false);
        return CompletableFuture.completedFuture(chunk);
    }
    @Override public void buildSurface(ChunkRegion region, StructureAccessor structures, NoiseConfig noise, Chunk chunk) {}
    @Override public void carve(ChunkRegion region, long seed, NoiseConfig noise, BiomeAccess biomes, StructureAccessor structures, Chunk chunk, GenerationStep.Carver step) {}
    @Override public void populateEntities(ChunkRegion region) {}
    @Override public void generateFeatures(StructureWorldAccess world, Chunk chunk, StructureAccessor structures) {}
    @Override public int getWorldHeight() { return 384; }
    @Override public int getMinimumY() { return -64; }
    @Override public int getSeaLevel() { return -64; }
    @Override public int getHeight(int x, int z, Heightmap.Type type, HeightLimitView world, NoiseConfig noise) { return TerrainSpec.height(x, z, seed) + 1; }
    @Override public VerticalBlockSample getColumnSample(int x, int z, HeightLimitView world, NoiseConfig noise) {
        BlockState[] column = new BlockState[world.getHeight()]; Arrays.fill(column, Blocks.AIR.getDefaultState());
        for (int y = Math.max(0, world.getBottomY()), h = Math.min(TerrainSpec.height(x,z,seed),world.getTopY()-1); y <= h; y++)
            column[y-world.getBottomY()] = SpaceMatched.BLOCKS[TerrainSpec.colorIndex(x,y,z,seed)].getDefaultState();
        return new VerticalBlockSample(world.getBottomY(), column);
    }
    @Override public void getDebugHudText(List<String> text, NoiseConfig noise, BlockPos pos) { text.add("Space matched terrain / seed="+seed+" / unit blocks / 1024 m"); }
}
