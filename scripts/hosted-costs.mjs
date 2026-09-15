// USD, 30-day month. Provider rates checked 2026-09-15.
// This estimates a proposed hibernating transport, not the existing polling CLI.
export const plans = [
    {name: 'dev', price: 3, people: 1, agents: 8, rooms: 3, messages: 20_000, requests: 200_000, storageGiB: 0.125},
    {name: 'team', price: 10, people: 5, agents: 40, rooms: 10, messages: 80_000, requests: 1_000_000, storageGiB: 0.625},
    {name: 'enterprise', price: 99, people: 25, agents: 200, rooms: 50, messages: 1_000_000, requests: 5_000_000, storageGiB: 5},
];
export function cost(plan, {writesPerMessage = 24, cpuMsPerRequest = 10, activeMsPerRequest = 50, feePercent = 0.061, feeFixed = 0.30} = {}) {
    // Conservative marginal pricing: included account-wide allowances excluded.
    const requestsWithReserve = plan.requests * 1.2;
    const eventsWithReserve = plan.messages + Math.max(1000, plan.messages * 0.05);
    const writes = eventsWithReserve * writesPerMessage / 1e6;
    const reads = requestsWithReserve * 1000 / 1e6 * 0.001;
    const requests = requestsWithReserve / 1e6 * (0.30 + 0.15);
    const cpu = requestsWithReserve * cpuMsPerRequest / 1e6 * 0.02;
    const duration = requestsWithReserve * activeMsPerRequest / 1000 * 0.128 / 1e6 * 12.50;
    const storage = plan.storageGiB * 1.2 * 1.073741824 * 0.20;
    const requestMeterWrites = requestsWithReserve / 1e6;
    const hosting = requestMeterWrites + writes + reads + requests + cpu + duration + storage;
    const fees = plan.price * feePercent + feeFixed;
    return {plan: plan.name, price: plan.price, hosting, fees, contribution: plan.price - hosting - fees,
        contributionPercent: (plan.price - hosting - fees) / plan.price * 100};
}
if (process.argv[1]?.endsWith('hosted-costs.mjs')) {
    for (const p of plans) console.log(JSON.stringify(cost(p)));
    console.log('Stress (48 writes/message, 20ms CPU, 100ms active):');
    for (const p of plans) console.log(JSON.stringify(cost(p, {writesPerMessage: 48, cpuMsPerRequest: 20, activeMsPerRequest: 100})));
    console.log('Enterprise usage block:', JSON.stringify(cost({name:'enterprise usage block',price:10,messages:100_000,requests:500_000,storageGiB:0})));
    console.log('Always-active room marginal duration/month:', 30 * 86400 * 0.128 * 12.50 / 1e6);
}
