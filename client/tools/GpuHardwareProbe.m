// Local read-only Metal/IORegistry probe. No admin rights, injection, clock or
// power changes. Build: clang -fobjc-arc -framework Foundation -framework Metal
// -framework IOKit client/tools/GpuHardwareProbe.m -o /tmp/space-gpu-hardware
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOKit/IOKitLib.h>

static NSDictionary *properties(io_registry_entry_t entry) {
    CFMutableDictionaryRef value = NULL;
    if (IORegistryEntryCreateCFProperties(entry, &value, kCFAllocatorDefault, 0) != KERN_SUCCESS) return @{};
    return CFBridgingRelease(value);
}
static NSDictionary *snapshot(void) {
    NSMutableDictionary *clients = [NSMutableDictionary dictionary], *statistics = [NSMutableDictionary dictionary];
    io_iterator_t accelerators = 0;
    if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AGXAccelerator"), &accelerators) != KERN_SUCCESS) return @{};
    io_service_t accelerator;
    while ((accelerator = IOIteratorNext(accelerators))) {
        [statistics addEntriesFromDictionary:properties(accelerator)[@"PerformanceStatistics"] ?: @{}];
        io_iterator_t descendants = 0;
        if (IORegistryEntryCreateIterator(accelerator, kIOServicePlane, kIORegistryIterateRecursively, &descendants) == KERN_SUCCESS) {
            io_registry_entry_t entry;
            while ((entry = IOIteratorNext(descendants))) {
                NSDictionary *p = properties(entry); uint64_t entryID = 0;
                IORegistryEntryGetRegistryEntryID(entry, &entryID);
                NSString *creator = p[@"IOUserClientCreator"];
                if (creator && [p[@"AppUsage"] isKindOfClass:NSArray.class]) {
                    NSUInteger index = 0;
                    for (NSDictionary *usage in p[@"AppUsage"]) {
                        if (usage[@"accumulatedGPUTime"]) {
                            NSString *key = [NSString stringWithFormat:@"%llu:%lu", entryID, index];
                            clients[key] = @{@"creator":creator, @"value":usage[@"accumulatedGPUTime"], @"api":usage[@"API"] ?: @"unknown"};
                        }
                        index++;
                    }
                }
                IOObjectRelease(entry);
            }
            IOObjectRelease(descendants);
        }
        IOObjectRelease(accelerator);
    }
    IOObjectRelease(accelerators);
    return @{@"clients":clients, @"statistics":statistics};
}
static void emit(id value) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:&error];
    if (!data) { fprintf(stderr, "%s\n", error.description.UTF8String); exit(1); }
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String); fflush(stdout);
}
int main(int argc, const char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--capabilities") == 0) {
        NSMutableArray *devices = [NSMutableArray array];
        for (id<MTLDevice> device in MTLCopyAllDevices()) {
            NSMutableArray *sets = [NSMutableArray array];
            for (id<MTLCounterSet> set in device.counterSets) {
                NSMutableArray *names = [NSMutableArray array];
                for (id<MTLCounter> counter in set.counters) [names addObject:counter.name];
                [sets addObject:@{@"name":set.name, @"counters":names}];
            }
            [devices addObject:@{@"name":device.name, @"counterSets":sets,
                @"stageBoundary":@([device supportsCounterSampling:MTLCounterSamplingPointAtStageBoundary]),
                @"drawBoundary":@([device supportsCounterSampling:MTLCounterSamplingPointAtDrawBoundary]),
                @"captureTraceSupported":@([[MTLCaptureManager sharedCaptureManager] supportsDestination:MTLCaptureDestinationGPUTraceDocument])}];
        }
        emit(@{@"devices":devices, @"os":NSProcessInfo.processInfo.operatingSystemVersionString});
        if (!devices.count) { fprintf(stderr, "No Metal device visible; check sandbox/IOKit access.\n"); return 2; }
        return 0;
    }
    char *end = NULL; long count = argc == 2 ? strtol(argv[1], &end, 10) : 0;
    if (!end || *end || count < 1 || count > 3600) { fprintf(stderr,"Usage: space-gpu-hardware --capabilities | seconds:1-3600\n"); return 1; }
    NSDictionary *previous = snapshot(); NSTimeInterval last = NSProcessInfo.processInfo.systemUptime;
    if (![previous[@"statistics"] count]) { fprintf(stderr,"No AGX statistics visible.\n"); return 2; }
    for (long sample = 0; sample < count; sample++) { @autoreleasepool {
        [NSThread sleepForTimeInterval:1.0];
        NSDictionary *current = snapshot(); NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
        NSMutableDictionary *deltas = [NSMutableDictionary dictionary]; NSUInteger resets = 0, added = 0;
        for (NSString *key in current[@"clients"]) {
            NSDictionary *a = previous[@"clients"][key], *b = current[@"clients"][key];
            if (!a) { added++; continue; }
            unsigned long long old = [a[@"value"] unsignedLongLongValue], value = [b[@"value"] unsignedLongLongValue];
            if (value < old) { resets++; continue; }
            NSString *creator = b[@"creator"];
            deltas[creator] = @([deltas[creator] unsignedLongLongValue] + value - old);
        }
        NSMutableArray *active = [NSMutableArray array];
        for (NSString *creator in deltas) if ([deltas[creator] unsignedLongLongValue])
            [active addObject:@{@"creator":creator, @"accumulatedGPUTimeDelta":deltas[creator]}];
        [active sortUsingComparator:^NSComparisonResult(id a, id b) { return [b[@"accumulatedGPUTimeDelta"] compare:a[@"accumulatedGPUTimeDelta"]]; }];
        emit(@{@"wallTimeMs":@((long long)(NSDate.date.timeIntervalSince1970 * 1000)), @"intervalSeconds":@(now-last),
            @"scope":@"AGX system utilization; per-process driver accounting deltas, not GPU busy percentages",
            @"statistics":current[@"statistics"], @"processes":active, @"resetClients":@(resets), @"newClients":@(added),
            @"thermalState":@(NSProcessInfo.processInfo.thermalState), @"lowPowerMode":@(NSProcessInfo.processInfo.lowPowerModeEnabled)});
        previous = current; last = now;
    } }
} return 0; }
