import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8098';
const ACTIVITY_ID = Number(__ENV.ACTIVITY_ID || 100401);

const headers = {
  'Content-Type': 'application/json',
};

export default function () {
  const payload = JSON.stringify({
    userId: `guest_k6_${__VU}`,
    activityId: ACTIVITY_ID,
  });

  const response = http.post(
    `${BASE_URL}/api/v1/raffle/strategy/query_raffle_award_list`,
    payload,
    { headers }
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

  sleep(1);
}
