import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 30 },
    { duration: '1m', target: 30 },
    { duration: '30s', target: 50 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 100 },
    { duration: '1m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8098';
const ACTIVITY_ID = Number(__ENV.ACTIVITY_ID || 100401);
const SLEEP_SECONDS = Number(__ENV.SLEEP_SECONDS || 0.2);

const headers = {
  'Content-Type': 'application/json',
};

export default function () {
  const payload = JSON.stringify({
    userId: `guest_k6_query_${__VU}`,
    activityId: ACTIVITY_ID,
  });

  const response = http.post(
    `${BASE_URL}/api/v1/raffle/strategy/query_raffle_award_list`,
    payload,
    { headers, tags: { api: 'query_raffle_award_list' } }
  );

  check(response, {
    'HTTP status is 200': (res) => res.status === 200,
    'business code is 0000': (res) => {
      try {
        return res.json('code') === '0000';
      } catch (e) {
        return false;
      }
    },
  });

  if (SLEEP_SECONDS > 0) {
    sleep(SLEEP_SECONDS);
  }
}
