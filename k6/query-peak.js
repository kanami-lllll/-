import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8098';
const ACTIVITY_ID = Number(__ENV.ACTIVITY_ID || 100401);
const TARGET_RPS = Number(__ENV.TARGET_RPS || 200);
const DURATION = __ENV.DURATION || '1m';
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || Math.max(50, TARGET_RPS));
const MAX_VUS = Number(__ENV.MAX_VUS || Math.max(PRE_ALLOCATED_VUS, TARGET_RPS * 2));
const DEBUG = (__ENV.DEBUG || 'false').toLowerCase() === 'true';

export const queryRequests = new Counter('query_requests');
export const querySuccessRate = new Rate('query_success_rate');
export const queryReqDuration = new Trend('query_req_duration');
export const queryBusinessFailures = new Counter('query_business_failures');

export const options = {
  scenarios: {
    query_constant_rps: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    query_success_rate: ['rate>0.99'],
    query_req_duration: ['p(95)<1500'],
  },
};

const headers = {
  'Content-Type': 'application/json',
};

export default function () {
  const payload = JSON.stringify({
    userId: `guest_k6_query_peak_${__VU}_${__ITER}`,
    activityId: ACTIVITY_ID,
  });

  const response = http.post(
    `${BASE_URL}/api/v1/raffle/strategy/query_raffle_award_list`,
    payload,
    { headers, tags: { api: 'query_raffle_award_list' } }
  );

  queryRequests.add(1);
  queryReqDuration.add(response.timings.duration);

  let businessOk = false;
  try {
    businessOk = response.status === 200 && response.json('code') === '0000';
  } catch (e) {
    businessOk = false;
  }

  querySuccessRate.add(businessOk);
  if (!businessOk) {
    queryBusinessFailures.add(1);
    if (DEBUG) {
      console.log(`query failed status=${response.status} body=${response.body}`);
    }
  }

  check(response, {
    'query HTTP status is 200': (res) => res.status === 200,
    'query business code is 0000': () => businessOk,
  });
}
