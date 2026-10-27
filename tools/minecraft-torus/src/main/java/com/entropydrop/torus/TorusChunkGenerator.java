package com.entropydrop.torus;

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
public final class TorusChunkGenerator extends ChunkGenerator {
    public static final MapCodec<TorusChunkGenerator> CODEC = RecordCodecBuilder.mapCodec(i -> i.group(
        Biome.REGISTRY_CODEC.fieldOf("biome").forGetter(g -> g.biome),
        Codec.STRING.fieldOf("terrain").forGetter(g -> g.terrain)
    ).apply(i, TorusChunkGenerator::new));
    private final RegistryEntry<Biome> biome;
    public final String terrain;
    public TorusChunkGenerator(RegistryEntry<Biome> biome, String terrain) { super(new FixedBiomeSource(biome)); this.biome = biome; this.terrain = terrain; }
    @Override protected MapCodec<? extends ChunkGenerator> getCodec() { return CODEC; }
    @Override public CompletableFuture<Chunk> populateNoise(Blender blender, NoiseConfig noise, StructureAccessor structures, Chunk chunk) {
        BlockPos.Mutable pos = new BlockPos.Mutable();
        short[] data=TerrainData.chunk(terrain,chunk.getPos().x,chunk.getPos().z);
        for(int y=0;y<256;y++)for(int z=0;z<16;z++)for(int x=0;x<16;x++){
            int id=data[y*256+z*16+x]&65535;
            if(id!=0)chunk.setBlockState(pos.set(chunk.getPos().getStartX()+x,y,chunk.getPos().getStartZ()+z),TorusMod.BLOCKS[id].getDefaultState(),false);
        }
        return CompletableFuture.completedFuture(chunk);
    }
    @Override public void buildSurface(ChunkRegion region, StructureAccessor structures, NoiseConfig noise, Chunk chunk) {}
    @Override public void carve(ChunkRegion region, long seed, NoiseConfig noise, BiomeAccess biomes, StructureAccessor structures, Chunk chunk, GenerationStep.Carver step) {}
    @Override public void populateEntities(ChunkRegion region) {}
    @Override public void generateFeatures(StructureWorldAccess world, Chunk chunk, StructureAccessor structures) {}
    @Override public int getWorldHeight() { return 384; }
    @Override public int getMinimumY() { return -64; }
    @Override public int getSeaLevel() { return -64; }
    @Override public int getHeight(int x, int z, Heightmap.Type type, HeightLimitView world, NoiseConfig noise) { return TerrainData.height(terrain,x,z); }
    @Override public VerticalBlockSample getColumnSample(int x, int z, HeightLimitView world, NoiseConfig noise) {
        BlockState[] column = new BlockState[world.getHeight()]; Arrays.fill(column, Blocks.AIR.getDefaultState());
        short[] data=TerrainData.chunk(terrain,Math.floorDiv(x,16),Math.floorDiv(z,16));
        for(int y=0;y<256;y++)column[y-world.getBottomY()]=TorusMod.BLOCKS[data[y*256+Math.floorMod(z,16)*16+Math.floorMod(x,16)]&65535].getDefaultState();
        return new VerticalBlockSample(world.getBottomY(), column);
    }
    @Override public void getDebugHudText(List<String> text, NoiseConfig noise, BlockPos pos) { text.add("Space torus / "+terrain+" / standard cells / bounded eight-zone fixture"); }
}
