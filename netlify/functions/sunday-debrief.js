const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

const RECIPIENTS = ['kevin@sondergrouputah.com', 'steven@sondergrouputah.com'];
const FROM_EMAIL = 'Sonder Legacy <onboarding@resend.dev>';
const AGENTS = ['Kevin', 'Steven', 'Chris', 'Logan', 'Pepper'];
const MINS = { calls: 20, convos: 5, followups: 5, refs: 5 };

async function supabaseQuery(table, filters) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?`;
  const params = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join('&');
  url += params + '&select=*';
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return await res.json();
}

exports.handler = async function(event, context) {
  try {
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    // Get last 7 days of data using REST API directly
    const url = `${SUPABASE_URL}/rest/v1/daily_activity?date=gte.${weekAgoStr}&select=*`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const weekData = await res.json();
    const rows_all = Array.isArray(weekData) ? weekData : [];

    // Build per-agent stats
    const agentStats = AGENTS.map(name => {
      const rows = rows_all.filter(r => r.agent_name === name);
      if (rows.length === 0) return { name, noData: true };

      const avg = key => Math.round(rows.reduce((s, r) => s + (r[key] || 0), 0) / rows.length);
      const total = key => rows.reduce((s, r) => s + (r[key] || 0), 0);
      const last = rows[rows.length - 1];

      const avgCalls = avg('calls');
      const avgConvos = avg('convos');
      const avgFollowups = avg('followups');
      const avgRefs = avg('refs');
      const totalAppts = total('appts');
      const daysSubmitted = rows.filter(r => r.submitted).length;
      const storiesDone = rows.filter(r => r.story).length;
      const activeListings = last?.active_listings || 0;
      const activeBuyers = last?.active_buyers || 0;
      const closings = last?.closings || 0;
      const leads = last?.leads || 0;
      const apptHeld = last?.appt_held || 0;
      const leadToAppt = leads > 0 ? Math.round((apptHeld / leads) * 100) : 0;
      const minimumsScore = [avgCalls >= MINS.calls, avgConvos >= MINS.convos, avgFollowups >= MINS.followups, avgRefs >= MINS.refs].filter(Boolean).length;

      return {
        name, daysSubmitted, storiesDone,
        avgCalls, avgConvos, avgFollowups, avgRefs,
        totalAppts, activeListings, activeBuyers, closings,
        leadToAppt, minimumsScore, noData: false
      };
    });

    const statsText = agentStats.map(s => {
      if (s.noData) return `${s.name}: No data logged this week.`;
      return `${s.name}:
- Days submitted: ${s.daysSubmitted}/7
- Avg daily calls: ${s.avgCalls} (min: 20) — ${s.avgCalls >= MINS.calls ? 'MET' : 'MISSED'}
- Avg daily convos: ${s.avgConvos} (min: 5) — ${s.avgConvos >= MINS.convos ? 'MET' : 'MISSED'}
- Avg daily follow-ups: ${s.avgFollowups} (min: 5) — ${s.avgFollowups >= MINS.followups ? 'MET' : 'MISSED'}
- Avg daily referrals asked: ${s.avgRefs} (min: 5) — ${s.avgRefs >= MINS.refs ? 'MET' : 'MISSED'}
- Minimums hit: ${s.minimumsScore}/4
- Stories posted: ${s.storiesDone}/7 days
- Appointments set: ${s.totalAppts}
- Active listings: ${s.activeListings}
- Active buyers: ${s.activeBuyers}
- Closings: ${s.closings}
- Lead to appt ratio: ${s.leadToAppt}%`;
    }).join('\n\n');

    const prompt = `You are a sharp, direct real estate team coach writing a weekly Sunday evening performance debrief for Kevin, the broker at Sonder Legacy in Utah.

This report goes to Kevin and Steven (team leads). Be direct, data-driven, and honest. Write like a coach who genuinely cares — not corporate, not fluffy, but real.

Here is this week's data:

${statsText}

Daily minimums: 20 calls, 5 conversations, 5 follow-ups, 5 referrals asked per day.
Weekly goals: 3-5 appointments, 1 story/day, consistent submission.

Write a debrief with:
1. TEAM SUMMARY (2-3 sentences) — overall week, tone, standouts
2. One section per agent — what they crushed, what they missed, any patterns, ONE Monday morning action item
3. MONDAY MORNING PRIORITIES — ranked list of who needs attention first and why

Keep each agent section to 4-6 sentences. Be specific with numbers. Don't sugarcoat. Don't be mean. Be a great coach.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const aiData = await aiRes.json();
    
    if (!aiData.content) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'AI response failed', aiData })
      };
    }
    
    const debrief = aiData.content.map(b => b.text || '').join('').trim();

    const weekRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const htmlBody = debrief
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^## (.*?)$/gm, '<h2 style="font-family:Georgia,serif;color:#0f2557;font-size:18px;margin:24px 0 8px;border-bottom:2px solid #c9a84c;padding-bottom:6px">$1</h2>')
      .replace(/^### (.*?)$/gm, '<h3 style="font-family:Georgia,serif;color:#0f2557;font-size:15px;margin:16px 0 6px">$1</h3>')
      .replace(/\n\n/g, '</p><p style="margin:0 0 14px">')
      .replace(/\n/g, '<br>');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Georgia,serif;background:#f4f5f9;margin:0;padding:20px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:#0f2557;padding:28px 32px;text-align:center">
      <div style="font-size:28px;margin-bottom:8px">🏡</div>
      <div style="font-family:Georgia,serif;font-size:22px;color:#fff;margin-bottom:4px">Sonder Legacy</div>
      <div style="font-size:12px;color:#c9a84c;text-transform:uppercase;letter-spacing:.1em">Weekly Performance Debrief</div>
      <div style="font-size:13px;color:rgba(255,255,255,.6);margin-top:8px">${weekRange}</div>
    </div>
    <div style="padding:32px;font-size:15px;line-height:1.8;color:#1a1a2e">
      <p style="margin:0 0 14px">${htmlBody}</p>
    </div>
    <div style="background:#f4f5f9;padding:20px 32px;text-align:center;font-size:12px;color:#888">
      Sonder Legacy CRM &middot; sonderlegacy.org<br>
      Generated every Sunday at 5PM MT
    </div>
  </div>
</body></html>`;

    // Send via Resend
    const results = [];
    for (const recipient of RECIPIENTS) {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RESEND_KEY}`
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: recipient,
          subject: `Sonder Legacy Weekly Debrief — ${weekRange}`,
          html: html
        })
      });
      const emailData = await emailRes.json();
      results.push(emailData);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, results })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, stack: err.stack })
    };
  }
};
