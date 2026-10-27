package com.entropydrop.torus;
import net.fabricmc.api.ModInitializer;
import net.minecraft.block.*;
import net.minecraft.registry.*;
import net.minecraft.util.Identifier;
public final class TorusMod implements ModInitializer {
 public static final Block[] BLOCKS=new Block[TerrainData.PALETTE.length];
 public void onInitialize(){BLOCKS[0]=Blocks.AIR;for(int i=1;i<BLOCKS.length;i++){final int value=TerrainData.PALETTE[i];BLOCKS[i]=Registry.register(Registries.BLOCK,Identifier.of("space_torus","color_"+i),new Block(AbstractBlock.Settings.copy(Blocks.STONE).luminance(state->(value>>>24&1)!=0?15:0)));}Registry.register(Registries.CHUNK_GENERATOR,Identifier.of("space_torus","terrain"),TorusChunkGenerator.CODEC);TorusPreparation.install();}
}
