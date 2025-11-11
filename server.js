// server.js (VERSÃO FINAL COM ATRIBUIÇÃO SERVER-SIDE)

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// MIDDLEWARE
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Essencial para ler o body do fetch
app.use(cors());

// VARIÁVEIS DE AMBIENTE (Render Environment)
const PUSHIN_TOKEN = process.env.PUSHIN_TOKEN;
// PRECISAMOS DAS CHAVES DO FACEBOOK DE VOLTA
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN; // Você precisa ter essa variável no Render
const FACEBOOK_PIXEL_ID = '25903937665861280'; // Seu ID de Pixel

// OBJETOS DE CONTROLE DE STATUS E ATRIBUIÇÃO
const paymentStatus = {};
const paymentAttribution = {}; // Onde vamos salvar o fbc/fbp

// ===========================================
// FUNÇÃO DO PIXEL FACEBOOK (RE-ADICIONADA E MELHORADA)
// ===========================================
async function trackFacebookEvent(eventName, parameters = {}) {
    
    // Prepara o payload user_data
    const userData = {
        // Você pode adicionar IP e User Agent se capturar no /gerar-pix
        // client_ip_address: parameters.ip || "0.0.0.0",
        // client_user_agent: parameters.user_agent || "unknown"
    };

    // Adiciona FBP e FBC (Click ID) - ESSA É A MÁGICA
    if (parameters.fbp) {
        userData.fbp = parameters.fbp;
    }
    if (parameters.fbc) {
        userData.fbc = parameters.fbc;
    }

    try {
        const response = await fetch(`https://graph.facebook.com/v17.0/${FACEBOOK_PIXEL_ID}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [{
                    event_name: eventName,
                    event_time: Math.floor(Date.now() / 1000),
                    action_source: "website",
                    user_data: userData, // Envia os dados de atribuição
                    custom_data: parameters.custom_data || {}
                }],
                access_token: FACEBOOK_ACCESS_TOKEN
            })
        });

        const result = await response.json();
        console.log(`✅ Facebook Pixel (${eventName}) com atribuição:`, result);
        return result;
    } catch (error) {
        console.error(`❌ Erro no Facebook Pixel (${eventName}):`, error.message);
    }
}

// ROTA PARA GERAR O PIX (AGORA SALVA A ATRIBUIÇÃO)
app.post('/gerar-pix', async (req, res) => {
    try {
        // 1. CAPTURAR DADOS DE ATRIBUIÇÃO DO BODY
        const { fbp, fbc } = req.body;
        console.log("Dados de atribuição recebidos:", { fbp, fbc });

        // 2. Chamar a API da PushinPay
        const apiUrl = 'https://api.pushinpay.com.br/api/pix/cashIn';
        const paymentData = {
            value: 299, // R$ 19,99 em centavos
            webhook_url: `https://gruposecreto-backend.onrender.com/webhook-pushinpay`
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${PUSHIN_TOKEN}`
            },
            body: JSON.stringify(paymentData)
        });

        const data = await response.json();
        
        if (!response.ok || !data.id) {
            console.error('ERRO na API PushinPay:', data);
            throw new Error(data.message || 'Resposta inválida da API');
        }

        const normalizedId = data.id.toLowerCase();
        paymentStatus[normalizedId] = "created";

        // 3. SALVAR OS DADOS DE ATRIBUIÇÃO JUNTO COM O ID DO PIX
        paymentAttribution[normalizedId] = { 
            fbp: fbp, 
            fbc: fbc
            // ip: req.ip, // (opcional)
            // user_agent: req.headers['user-agent'] // (opcional)
        };
        
        console.log(`✅ PIX gerado! ID: ${normalizedId}`);
        // O AddToCart da Utmify (no frontend) cuida disso

        res.json({
            paymentId: normalizedId,
            qrCodeBase64: data.qr_code_base64,
            copiaECola: data.qr_code
        });

    } catch (error) {
        console.error('Erro ao gerar PIX:', error.message);
        res.status(500).json({ error: 'Não foi possível gerar o PIX.' });
    }
});

// ROTA DO WEBHOOK (AGORA DISPARA O PURCHASE COM ATRIBUIÇÃO)
app.post('/webhook-pushinpay', async (req, res) => {
    console.log("Webhook da PushinPay recebido!");
    
    let webhookData = req.body;
    
    // Processamento do Webhook (JSON ou string)
    if (typeof webhookData === 'string') {
        try {
            webhookData = JSON.parse(webhookData);
        } catch (e) {
            console.error("Erro no parse JSON:", e.message);
        }
    }

    console.log("Dados do Webhook (processado):", webhookData);

    if (webhookData && webhookData.id) {
        const normalizedId = webhookData.id.toLowerCase();
        console.log(`🎉 Webhook recebido - ID: ${normalizedId}, Status: ${webhookData.status}`);
        
        if (webhookData.status === 'paid') {
            paymentStatus[normalizedId] = 'paid';
            console.log(`💰 PAGAMENTO CONFIRMADO: ${normalizedId}`);

            // 1. RECUPERAR DADOS DE ATRIBUIÇÃO
            const attributionData = paymentAttribution[normalizedId];

            if (attributionData) {
                console.log(`🎯 Disparando Purchase com atribuição:`, attributionData);
                // 2. DISPARAR O PURCHASE COM OS DADOS
                await trackFacebookEvent('Purchase', {
                    fbp: attributionData.fbp,
                    fbc: attributionData.fbc,
                    custom_data: {
                        currency: 'BRL',
                        value: 19.99,
                        transaction_id: normalizedId
                    }
                });
                
                // 3. Limpar dados para não ocupar memória
                delete paymentAttribution[normalizedId];
            } else {
                console.log(`❌ Purchase não disparado. Não foram encontrados dados de atribuição para: ${normalizedId}`);
            }
        } else {
            paymentStatus[normalizedId] = webhookData.status;
            console.log(`Status atualizado: ${normalizedId} -> ${webhookData.status}`);
        }
    }

    res.status(200).json({ success: true, message: "Webhook processado" });
});

// ROTA DE VERIFICAÇÃO DE STATUS (NÃO MUDA)
app.get('/check-status/:paymentId', (req, res) => {
    const paymentId = req.params.paymentId.toLowerCase();
    const status = paymentStatus[paymentId] || 'not_found';
    
    res.json({ 
        paymentId,
        status: status,
        message: status === 'paid' ? 'Pagamento confirmado!' : 'Aguardando pagamento'
    });
});

// ROTA EXTRA: Listar todos os pagamentos (para debug)
app.get('/payments', (req, res) => {
    res.json({
        totalPayments: Object.keys(paymentStatus).length,
        payments: paymentStatus,
        attributions: paymentAttribution // Para você ver se a atribuição está sendo salva
    });
});

// Health check
app.get('/', (req, res) => {
    res.json({ 
        message: 'Sistema de PIX V2 (com atribuição) funcionando!',
        endpoints: {
            gerarPix: 'POST /gerar-pix',
            webhook: 'POST /webhook-pushinpay',
            checkStatus: 'GET /check-status/:paymentId',
            listPayments: 'GET /payments'
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor V2 (com atribuição) rodando na porta ${PORT}`);
    console.log(`🎯 Facebook Pixel configurado: ${FACEBOOK_PIXEL_ID}`);
});
