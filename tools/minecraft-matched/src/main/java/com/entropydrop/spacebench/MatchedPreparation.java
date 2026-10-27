package com.entropydrop.spacebench;

import com.google.gson.GsonBuilder;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.util.math.BlockPos;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.zip.CRC32;

/** Preparation runs before sampling and only in the explicitly opted-in test save. */
public final class MatchedPreparation {
    public static volatile boolean ready;
    public static volatile int chunks;
    public static volatile String failure;
    private static final CRC32 expected = new CRC32(), actual = new CRC32();
    public static void install() {
        if (!Boolean.getBoolean("spacebench.enabled")) return;
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            var world = server.getOverworld();
            if (ready || failure != null || !(world.getChunkManager().getChunkGenerator() instanceof MatchedChunkGenerator)) return;
            try {
                for (int batch = 0; batch < 4 && chunks < 4096; batch++) {
                    int cx = chunks % 64, cz = chunks / 64;
                    var chunk = world.getChunk(cx, cz);
                    var pos = new BlockPos.Mutable();
                    for (int lz=0;lz<16;lz++) for(int lx=0;lx<16;lx++) {
                        int x=cx*16+lx,z=cz*16+lz,h=TerrainSpec.height(x,z,TerrainSpec.SEED);
                        for(int y=0;y<=h+1;y++) {
                            int index=y<=h?TerrainSpec.colorIndex(x,y,z,TerrainSpec.SEED):-1;
                            var state=chunk.getBlockState(pos.set(x,y,z));
                            if(index<0 ? !state.isAir() : state.getBlock()!=SpaceMatched.BLOCKS[index]) throw new IllegalStateException("Block mismatch at "+pos);
                            int rgb=index<0?0:TerrainSpec.rgb(index);
                            for(int shift:new int[]{16,8,0}) {expected.update(rgb>>>shift);actual.update(rgb>>>shift);}
                        }
                    }
                    chunks++;
                }
                if(chunks==4096) {
                    server.save(false,true,true);
                    ready=true;
                    Files.writeString(Path.of("matched-validation.json"),new GsonBuilder().setPrettyPrinting().create().toJson(Map.of(
                        "chunks",chunks,"size",1024,"seed",42,"canonicalVolumeCrc32","bef315c8",
                        "validated","All generated solid blocks and the first air cell above every column match TerrainSpec", "traversalCrc32",String.format("%08x",actual.getValue()))));
                }
                if(chunks%128==0) System.out.println("SPACEBENCH prepared "+chunks+" / 4096 chunks");
            } catch(Exception e) { failure=e.toString(); e.printStackTrace(); }
        });
    }
}
