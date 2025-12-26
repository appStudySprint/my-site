/**
 * Netlify Serverless Function: Gemini API Proxy
 * 
 * Diese Funktion fungiert als sicherer Proxy zwischen Frontend und Google Gemini API.
 * Der API-Key wird sicher in Netlify Environment Variables gespeichert.
 * 
 * Setup in Netlify Dashboard:
 * Site Settings → Environment Variables → Add variable
 * Key: GEMINI_API_KEY
 * Value: (Dein API-Key)
 */

export default async (req, context) => {
  // CORS Headers für lokale Entwicklung und Production
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Handle OPTIONS request (CORS preflight)
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  // Nur POST-Requests erlauben
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed. Use POST.' }),
      { status: 405, headers }
    );
  }

  try {
    // 1. Hole den API-Key sicher aus Environment Variables
    // Unterstütze sowohl process.env (Standard) als auch Netlify.env.get() (Netlify-spezifisch)
    const apiKey = process.env.GEMINI_API_KEY || Netlify?.env?.get('GEMINI_API_KEY');

    if (!apiKey) {
      console.error('❌ GEMINI_API_KEY ist nicht in den Netlify Environment Variables konfiguriert!');
      return new Response(
        JSON.stringify({ 
          error: 'Server configuration error: API Key missing',
          hint: 'Please set GEMINI_API_KEY in Netlify Environment Variables'
        }),
        { status: 500, headers }
      );
    }

    // 2. Lese den Body vom Frontend
    let body;
    try {
      body = await req.json();
    } catch (parseError) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { status: 400, headers }
      );
    }

    console.log('📡 Forwarding request to Google Gemini API...');

    // 3. Leite die Anfrage an Google weiter (Server-to-Server)
    // Verwende gemini-1.5-flash (stabil, höhere Rate-Limits: 1.500 Requests/Tag im Free Tier)
    const googleApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    let googleResponse;
    try {
      googleResponse = await fetch(googleApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (fetchError) {
      console.error('❌ Network error beim Abruf der Google API:', fetchError);
      return new Response(
        JSON.stringify({ 
          error: 'Network error',
          message: 'Could not reach Google API'
        }),
        { status: 500, headers }
      );
    }

    // 4. Lese die Antwort von Google
    const responseText = await googleResponse.text();
    
    // Wenn Google einen Fehler zurückgibt (inkl. 404), leite ihn als JSON weiter
    if (!googleResponse.ok) {
      console.error(`❌ Google API Error (${googleResponse.status}):`, responseText);
      
      // Versuche, die Antwort als JSON zu parsen, falls möglich
      let errorBody;
      try {
        errorBody = JSON.parse(responseText);
      } catch {
        errorBody = { error: responseText };
      }
      
      return new Response(
        JSON.stringify({
          error: `Google API Error (${googleResponse.status})`,
          details: errorBody
        }),
        { 
          status: googleResponse.status, 
          headers 
        }
      );
    }

    console.log('✅ Successfully proxied request to Gemini API');

    // 5. Sende die erfolgreiche Antwort zurück zum Frontend
    return new Response(responseText, { 
      status: 200, 
      headers 
    });

  } catch (error) {
    console.error('❌ Proxy Error:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      }),
      { status: 500, headers }
    );
  }
};
