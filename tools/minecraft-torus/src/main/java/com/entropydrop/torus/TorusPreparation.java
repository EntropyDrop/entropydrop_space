package com.entropydrop.torus;
import com.google.gson.*;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.util.math.BlockPos;
import java.nio.file.*;
import java.util.*;
import java.util.zip.CRC32;
public final class TorusPreparation {
 public static volatile boolean ready;public static volatile int chunks;public static volatile String failure;
 private static JsonArray records;private static final IdentityHashMap<net.minecraft.block.Block,Integer> ids=new IdentityHashMap<>();
 public static void install(){if(!Boolean.getBoolean("space_torus.benchmark"))return;
  ServerTickEvents.END_SERVER_TICK.register(server->{var world=server.getOverworld();if(ready||failure!=null||!(world.getChunkManager().getChunkGenerator() instanceof TorusChunkGenerator generator))return;
   try{if(records==null){
     if(Boolean.getBoolean("space_torus.reuseValidation") && Files.exists(Path.of("torus-validation.json"))){
      var previous=JsonParser.parseString(Files.readString(Path.of("torus-validation.json"))).getAsJsonObject();
      if(previous.get("world").getAsString().equals(generator.terrain) && previous.get("allCellsVerified").getAsBoolean() && previous.get("sourceSha256").getAsString().equals(TerrainData.manifest(generator.terrain).get("sha256").getAsString())){chunks=previous.get("chunks").getAsInt();ready=true;return;}
      throw new IllegalStateException("Saved validation does not match this fixture");
     }
     records=TerrainData.manifest(generator.terrain).getAsJsonArray("chunks");for(int i=0;i<TorusMod.BLOCKS.length;i++)ids.put(TorusMod.BLOCKS[i],i);}
    for(int batch=0;batch<4 && chunks<records.size();batch++){
     var row=records.get(chunks).getAsJsonObject();int cx=row.get("x").getAsInt(),cz=row.get("z").getAsInt();var chunk=world.getChunk(cx,cz);var pos=new BlockPos.Mutable();byte[] canonical=new byte[65536*4];
     for(int y=0;y<256;y++)for(int z=0;z<16;z++)for(int x=0;x<16;x++){
      var state=chunk.getBlockState(pos.set(cx*16+x,y,cz*16+z));Integer id=ids.get(state.getBlock());if(id==null)throw new IllegalStateException("Unexpected block at "+pos);
      int value=id==0?0:TerrainData.PALETTE[id]|0x80000000;int at=(y*256+z*16+x)*4;canonical[at]=(byte)value;canonical[at+1]=(byte)(value>>>8);canonical[at+2]=(byte)(value>>>16);canonical[at+3]=(byte)(value>>>24);
     }
     CRC32 crc=new CRC32();crc.update(canonical);if(crc.getValue()!=row.get("crc32").getAsLong())throw new IllegalStateException("Chunk checksum differs "+cx+","+cz);chunks++;
    }
    if(chunks==records.size()){server.save(false,true,true);ready=true;Files.writeString(Path.of("torus-validation.json"),new Gson().toJson(Map.of("world",generator.terrain,"chunks",chunks,"allCellsVerified",true,"sourceSha256",TerrainData.manifest(generator.terrain).get("sha256").getAsString())));}
    if(chunks%256==0)System.out.println("SPACE_TORUS prepared "+chunks+" / "+records.size());
   }catch(Exception e){failure=e.toString();e.printStackTrace();}
  });
 }
}
