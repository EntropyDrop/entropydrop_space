"""Create a NEW isolated save; requires nbtlib. Never copies region/player data files."""
import argparse, copy
from pathlib import Path
import nbtlib as n
p=argparse.ArgumentParser();p.add_argument('template',type=Path);p.add_argument('destination',type=Path);a=p.parse_args()
if a.destination.exists(): raise SystemExit('Refusing to overwrite an existing save')
f=n.load(a.template);d=f['Data']
d['LevelName']=n.String('Matched Blocks');d['GameType']=n.Int(1);d['allowCommands']=n.Byte(1);d['Difficulty']=n.Byte(0)
d['WorldGenSettings']['seed']=n.Long(42);d['WorldGenSettings']['generate_features']=n.Byte(0)
d['WorldGenSettings']['dimensions']['minecraft:overworld']['generator']=n.Compound({'type':n.String('spacebench:matched'),'biome':n.String('minecraft:plains'),'seed':n.Int(42)})
for key in ['doMobSpawning','doDaylightCycle','doWeatherCycle','doTraderSpawning','doPatrolSpawning']: d['GameRules'][key]=n.String('false')
d['GameRules']['randomTickSpeed']=n.String('0')
d['DayTime']=n.Long(6000);d['Time']=n.Long(0);d['raining']=n.Byte(0);d['thundering']=n.Byte(0)
d['SpawnX']=n.Int(512);d['SpawnY']=n.Int(96);d['SpawnZ']=n.Int(512)
d['Player']['Pos']=n.List[n.Double]([512.5,94.38,512.5]);d['Player']['Rotation']=n.List[n.Float]([180,18])
d['Player']['Motion']=n.List[n.Double]([0,0,0]);d['Player']['Inventory']=n.List[n.Compound]();d['Player']['abilities']['flying']=n.Byte(1)
a.destination.mkdir(parents=True);f.save(a.destination/'level.dat');print(a.destination)
