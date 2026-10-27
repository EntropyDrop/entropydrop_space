package com.entropydrop.spacebench;

import net.fabricmc.api.ModInitializer;
import net.minecraft.block.AbstractBlock;
import net.minecraft.block.Block;
import net.minecraft.block.Blocks;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

public final class SpaceMatched implements ModInitializer {
    public static final Block[] BLOCKS = new Block[256];
    @Override public void onInitialize() {
        for (int i = 0; i < BLOCKS.length; i++) BLOCKS[i] = Registry.register(Registries.BLOCK,
            Identifier.of("spacebench", "color_"+i), new Block(AbstractBlock.Settings.copy(Blocks.STONE)));
        MatchedPreparation.install();
        Registry.register(Registries.CHUNK_GENERATOR, Identifier.of("spacebench", "matched"), MatchedChunkGenerator.CODEC);
    }
}
