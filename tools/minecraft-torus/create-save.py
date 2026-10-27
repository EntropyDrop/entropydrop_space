"""Create a NEW isolated save; requires nbtlib. Never copies region/player data files."""
import argparse, copy
from pathlib import Path
import nbtlib as n
p=argparse.ArgumentParser();p.add_argument('template',type=Path);p.add_argument('destination',type=Path);p.add_argument('--terrain',required=True,choices=['nature','copper-metropolis','aether-archipelago']);a=p.parse_args()
if a.destination.exists(): raise SystemExit('Refusing to overwrite an existing save')
f=n.load(a.template);d=f['Data']
d['LevelName']=n.String('Torus '+a.terrain);d['GameType']=n.Int(1);d['allowCommands']=n.Byte(1);d['Difficulty']=n.Byte(0)
d['WorldGenSettings']['seed']=n.Long(42);d['WorldGenSettings']['generate_features']=n.Byte(0)
d['WorldGenSettings']['dimensions']['minecraft:overworld']['generator']=n.Compound({'type':n.String('space_torus:terrain'),'biome':n.String('minecraft:plains'),'terrain':n.String(a.terrain)})
for key in ['doMobSpawning','doDaylightCycle','doWeatherCycle','doTraderSpawning','doPatrolSpawning']: d['GameRules'][key]=n.String('false')
d['GameRules']['randomTickSpeed']=n.String('0')
d['DayTime']=n.Long(6000);d['Time']=n.Long(0);d['raining']=n.Byte(0);d['thundering']=n.Byte(0)
d['SpawnX']=n.Int(8192);d['SpawnY']=n.Int(180);d['SpawnZ']=n.Int(1024)
d['Player']['Pos']=n.List[n.Double]([8192.5,178.38,1024.5]);d['Player']['Rotation']=n.List[n.Float]([180,18])
d['Player']['Motion']=n.List[n.Double]([0,0,0]);d['Player']['Inventory']=n.List[n.Compound]();d['Player']['abilities']['flying']=n.Byte(1)
a.destination.mkdir(parents=True);f.save(a.destination/'level.dat');print(a.destination)
