package com.entropydrop.torus;
import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.InflaterInputStream;
import java.io.*;
public final class TerrainData {
 public static final Path ROOT=Path.of(System.getProperty("space_torus.data","data"));
 public static final int[] PALETTE=readPalette();
 private static final short[] EMPTY=new short[65536];
 private static final Map<String,short[]> CACHE=Collections.synchronizedMap(new LinkedHashMap<>(256,.75f,true){protected boolean removeEldestEntry(Map.Entry<String,short[]> e){return size()>256;}});
 private static int[] readPalette(){try{return new Gson().fromJson(Files.readString(ROOT.resolve("palette.json")),int[].class);}catch(Exception e){throw new IllegalStateException("Export terrain and set space_torus.data before launch",e);}}
 public static short[] chunk(String world,int x,int z){
  String key=world+"/"+x+"-"+z+".bin";short[] found=CACHE.get(key);if(found!=null)return found;
  Path path=ROOT.resolve(key);if(!Files.exists(path))return EMPTY;
  try(var input=new InflaterInputStream(Files.newInputStream(path))){byte[] bytes=input.readAllBytes();if(bytes.length!=131072)throw new IOException("Invalid chunk size");short[] data=new short[65536];for(int i=0;i<data.length;i++)data[i]=(short)((bytes[i*2]&255)|(bytes[i*2+1]&255)<<8);CACHE.put(key,data);return data;}catch(IOException e){throw new IllegalStateException(key,e);}
 }
 public static int height(String world,int x,int z){short[] data=chunk(world,Math.floorDiv(x,16),Math.floorDiv(z,16));int at=Math.floorMod(z,16)*16+Math.floorMod(x,16);for(int y=255;y>=0;y--)if(data[y*256+at]!=0)return y+1;return 0;}
 public static JsonObject manifest(String world){try{return JsonParser.parseString(Files.readString(ROOT.resolve(world+"/manifest.json"))).getAsJsonObject();}catch(IOException e){throw new IllegalStateException(e);}}
}
