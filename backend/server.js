const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Importar sistema de validación GPS con anti-fraude avanzado
const {
    validateGPSLocation,
    validateGPSLocationAdvanced,
    saveAttendanceRecord,
    formatValidationResponse,
    formatAdvancedValidationResponse,
    AUTHORIZED_LOCATIONS,
    GPS_CONFIG,
    ADVANCED_FRAUD_CONFIG
} = require('./gps-validation');

// Importar sistema de control de estados de asistencia
const {
    getEmployeeCurrentState,
    validateAttendanceAction,
    generateEmployeeStatusReport,
    detectMissingExits,
    formatStateValidationMessage,
    STATE_CONTROL_CONFIG
} = require('./attendance-state-control');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:5173",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Variables globales para WhatsApp
let whatsappClient = null;
let isWhatsAppConnected = false;
let currentQRCode = null;

// Estado para manejo de comandos de asistencia
const pendingAttendanceRequests = new Map(); // Para usuarios esperando ubicación

// Configuración de la base de datos
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'whatsapp_attendance',
    port: process.env.DB_PORT || 3306
};

// Función para conectar a la base de datos
async function connectToDatabase() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        console.log('✅ Conectado a MySQL');
        return connection;
    } catch (error) {
        console.error('❌ Error conectando a MySQL:', error.message);
        return null;
    }
}

// Función para guardar mensaje en base de datos
async function saveMessageLog(phoneNumber, messageText, messageType) {
    try {
        const connection = await connectToDatabase();
        if (connection) {
            await connection.execute(
                'INSERT INTO message_logs (phone_number, message_text, message_type) VALUES (?, ?, ?)',
                [phoneNumber, messageText, messageType]
            );
            await connection.end();
            console.log(`📝 Mensaje guardado: ${phoneNumber} - ${messageType}`);
        }
    } catch (error) {
        console.error('❌ Error guardando mensaje:', error.message);
    }
}

// Función para actualizar estado de WhatsApp en BD
async function updateWhatsAppStatus(isConnected, qrCode = null) {
    try {
        const connection = await connectToDatabase();
        if (connection) {
            if (isConnected) {
                await connection.execute(
                    'UPDATE whatsapp_status SET is_connected = ?, last_connected = NOW(), qr_code = NULL WHERE id = 1',
                    [isConnected]
                );
            } else {
                await connection.execute(
                    'UPDATE whatsapp_status SET is_connected = ?, qr_code = ? WHERE id = 1',
                    [isConnected, qrCode]
                );
            }
            await connection.end();
        }
    } catch (error) {
        console.error('❌ Error actualizando estado WhatsApp:', error.message);
    }
}

// Inicializar cliente de WhatsApp
function initializeWhatsApp() {
    console.log('🚀 Inicializando cliente de WhatsApp...');
    
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: "whatsapp-attendance-system"
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    // Evento: QR Code generado
    whatsappClient.on('qr', async (qr) => {
        console.log('📱 Código QR generado');
        
        try {
            // Generar QR Code como imagen base64
            const qrCodeImage = await qrcode.toDataURL(qr, {
                errorCorrectionLevel: 'M',
                type: 'image/png',
                quality: 0.92,
                margin: 1,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            });
            
            currentQRCode = qrCodeImage;
            
            // Enviar QR al frontend via WebSocket
            io.emit('qr-code', {
                qrCode: qrCodeImage,
                message: 'Escanea el código QR con WhatsApp'
            });
            
            // Guardar en base de datos
            await updateWhatsAppStatus(false, qrCodeImage);
            
        } catch (error) {
            console.error('❌ Error generando QR:', error.message);
        }
    });

    // Evento: Cliente listo
    whatsappClient.on('ready', async () => {
        console.log('✅ WhatsApp conectado y listo!');
        isWhatsAppConnected = true;
        currentQRCode = null;
        
        // Notificar al frontend
        io.emit('whatsapp-status', {
            connected: true,
            message: 'WhatsApp conectado correctamente'
        });
        
        // Actualizar base de datos
        await updateWhatsAppStatus(true);
    });

    // Evento: Desconectado
    whatsappClient.on('disconnected', async (reason) => {
        console.log('❌ WhatsApp desconectado:', reason);
        isWhatsAppConnected = false;
        currentQRCode = null;
        
        // Notificar al frontend
        io.emit('whatsapp-status', {
            connected: false,
            message: `WhatsApp desconectado: ${reason}`
        });
        
        // Actualizar base de datos
        await updateWhatsAppStatus(false);
        
        // Si la desconexión fue por logout o desvincular, reinicializar automáticamente
        if (reason === 'LOGOUT' || reason === 'UNPAIRED_PHONE') {
            console.log('🔄 Reinicializando cliente para generar nuevo QR...');
            setTimeout(() => {
                initializeWhatsApp();
            }, 3000);
        }
    });

    // Evento: Error de autenticación
    whatsappClient.on('auth_failure', async (message) => {
        console.error('❌ Error de autenticación:', message);
        
        io.emit('whatsapp-status', {
            connected: false,
            error: true,
            message: 'Error de autenticación. Intenta reconectar.'
        });
        
        await updateWhatsAppStatus(false);
    });

    // Evento: Mensaje recibido con GPS integrado
    whatsappClient.on('message', async (message) => {
        console.log('📨 Mensaje recibido:', {
            from: message.from,
            body: message.body,
            type: message.type,
            hasLocation: message.location ? 'SÍ' : 'NO',
            timestamp: new Date().toISOString()
        });

        // Guardar mensaje en base de datos
        await saveMessageLog(message.from, message.body, 'incoming');

        // Obtener información del contacto
        const contact = await message.getContact();
        
        // Notificar al frontend
        io.emit('message-received', {
            from: message.from,
            body: message.body,
            timestamp: new Date().toISOString(),
            contact: contact,
            hasLocation: !!message.location
        });

        // ========================================
        // MANEJO DE UBICACIÓN GPS
        // ========================================
        
        if (message.location) {
            console.log('📍 Ubicación recibida:', message.location);
            
            // Verificar si el usuario tenía una solicitud pendiente
            if (pendingAttendanceRequests.has(message.from)) {
                const pendingAction = pendingAttendanceRequests.get(message.from);
                pendingAttendanceRequests.delete(message.from);
                
                console.log(`🔍 Procesando ${pendingAction} con ubicación para ${message.from}`);
                
                // Validar ubicación GPS con sistema anti-fraude avanzado
                const validationResult = await validateGPSLocationAdvanced({
                    latitude: message.location.latitude,
                    longitude: message.location.longitude,
                    accuracy: message.location.accuracy,
                    timestamp: message.location.timestamp
                }, message.from);
                
                console.log('📊 Resultado validación ANTI-FRAUDE:', {
                    isValid: validationResult.isValid,
                    fraudRisk: validationResult.fraudRisk,
                    suspiciousFlags: validationResult.suspiciousFlags.length,
                    location: validationResult.location?.name
                });
                
                // Guardar registro en base de datos
                await saveAttendanceRecord(
                    message.from, 
                    pendingAction, 
                    {
                        latitude: message.location.latitude,
                        longitude: message.location.longitude,
                        accuracy: message.location.accuracy,
                        timestamp: message.location.timestamp
                    },
                    validationResult
                );
                
                // Generar respuesta con sistema anti-fraude
                const responseMessage = formatAdvancedValidationResponse(pendingAction, validationResult, message.from);
                
                // Enviar respuesta
                try {
                    await message.reply(responseMessage);
                    
                    // Guardar respuesta en base de datos
                    await saveMessageLog(message.from, responseMessage, 'outgoing');
                    
                    // Notificar al frontend
                    io.emit('message-sent', {
                        to: message.from,
                        body: responseMessage,
                        timestamp: new Date().toISOString()
                    });
                    
                    // Log del resultado
                    if (validationResult.isValid) {
                        console.log(`✅ ${pendingAction.toUpperCase()} VÁLIDA para ${message.from} en ${validationResult.location.name}`);
                    } else {
                        console.log(`❌ ${pendingAction.toUpperCase()} RECHAZADA para ${message.from}: ${validationResult.reasons.join(', ')}`);
                    }
                    
                } catch (error) {
                    console.error('❌ Error enviando respuesta GPS:', error.message);
                }
                
                return; // No procesar más el mensaje
            } else {
                // Ubicación sin solicitud previa
                const responseMessage = '📍 *Ubicación recibida*\n\n' +
                                       'No tenías ninguna solicitud de registro pendiente.\n' +
                                       'Envía *entrada* o *salida* para registrar tu asistencia.';
                
                try {
                    await message.reply(responseMessage);
                    await saveMessageLog(message.from, responseMessage, 'outgoing');
                    
                    io.emit('message-sent', {
                        to: message.from,
                        body: responseMessage,
                        timestamp: new Date().toISOString()
                    });
                } catch (error) {
                    console.error('❌ Error enviando respuesta ubicación:', error.message);
                }
                
                return;
            }
        }

        // ========================================
        // COMANDOS DE TEXTO
        // ========================================

        const messageBody = message.body.toLowerCase().trim();
        let responseMessage = null;

        // Comandos de asistencia con GPS y control de estados
        if (messageBody === '/entrada' || messageBody === 'entrada') {
            // VALIDAR PRIMERO si puede registrar entrada
            const actionValidation = await validateAttendanceAction(message.from, 'entrada');
            
            if (!actionValidation.isAllowed) {
                responseMessage = formatStateValidationMessage('entrada', actionValidation);
            } else {
                // Si está permitido, proceder con solicitud de ubicación
                pendingAttendanceRequests.set(message.from, 'entrada');
                responseMessage = formatStateValidationMessage('entrada', actionValidation);
            }

        } else if (messageBody === '/salida' || messageBody === 'salida') {
            // VALIDAR PRIMERO si puede registrar salida
            const actionValidation = await validateAttendanceAction(message.from, 'salida');
            
            if (!actionValidation.isAllowed) {
                responseMessage = formatStateValidationMessage('salida', actionValidation);
            } else {
                // Si está permitido, proceder con solicitud de ubicación
                pendingAttendanceRequests.set(message.from, 'salida');
                responseMessage = formatStateValidationMessage('salida', actionValidation);
            }

        } else if (messageBody === 'cancelar' || messageBody === '/cancelar') {
            if (pendingAttendanceRequests.has(message.from)) {
                const cancelledAction = pendingAttendanceRequests.get(message.from);
                pendingAttendanceRequests.delete(message.from);
                
                responseMessage = `❌ *Registro de ${cancelledAction.toUpperCase()} cancelado*\n\n` +
                                 'Puedes intentar nuevamente cuando quieras.\n' +
                                 'Envía *entrada* o *salida* para registrar tu asistencia.';
            } else {
                responseMessage = 'ℹ️ No tienes ningún registro pendiente para cancelar.';
            }

        } else if (messageBody === '/ayuda' || messageBody === 'ayuda') {
            responseMessage = '📋 *COMANDOS DISPONIBLES:*\n\n' +
                             '🟢 *entrada* - Registrar hora de entrada\n' +
                             '🔴 *salida* - Registrar hora de salida\n' +
                             '📊 *estado* - Ver último registro\n' +
                             '📍 *ubicaciones* - Ver puntos autorizados\n' +
                             '❌ *cancelar* - Cancelar registro pendiente\n' +
                             '❓ *ayuda* - Mostrar esta ayuda\n\n' +
                             '⚠️ *IMPORTANTE:* Para registrar entrada/salida necesitas compartir tu ubicación GPS actual.';

        } else if (messageBody === '/estado' || messageBody === 'estado') {
            // Generar reporte completo del estado del empleado
            try {
                responseMessage = await generateEmployeeStatusReport(message.from);
            } catch (error) {
                console.error('Error generando reporte de estado:', error.message);
                responseMessage = '❌ Error consultando tu estado. Intenta más tarde.';
            }

        } else if (messageBody === '/ubicaciones' || messageBody === 'ubicaciones') {
            responseMessage = '📍 *UBICACIONES AUTORIZADAS:*\n\n';
            
            AUTHORIZED_LOCATIONS.forEach((location, index) => {
                responseMessage += `${index + 1}️⃣ *${location.name}*\n`;
                responseMessage += `   📏 Radio: ${location.radius}m\n`;
                responseMessage += `   📱 Coordenadas: ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}\n\n`;
            });
            
            responseMessage += '⚠️ *Debes estar dentro del radio especificado para cada ubicación.*';

        } else if (messageBody.includes('hola') || messageBody.includes('buenos dias') || messageBody.includes('buenas tardes')) {
            responseMessage = '👋 *¡Hola!* Soy el bot de asistencia.\n\n' +
                             '🏢 Sistema de Control de Asistencia con GPS\n\n' +
                             '📋 Comandos principales:\n' +
                             '• *entrada* - Registrar ingreso\n' +
                             '• *salida* - Registrar salida\n' +
                             '• *ayuda* - Ver todos los comandos\n\n' +
                             '📍 Recuerda que necesitas compartir tu ubicación GPS para registrar asistencia.';

        } else {
            // Verificar si hay solicitud pendiente para dar contexto
            if (pendingAttendanceRequests.has(message.from)) {
                const pendingAction = pendingAttendanceRequests.get(message.from);
                responseMessage = `⏳ *Registro de ${pendingAction.toUpperCase()} pendiente*\n\n` +
                                 '📍 Envía tu ubicación actual para continuar.\n' +
                                 '❌ Responde *cancelar* si quieres cancelar.\n' +
                                 '❓ Responde *ayuda* si necesitas instrucciones.';
            } else {
                responseMessage = '❓ *Comando no reconocido*\n\n' +
                                 'Envía *ayuda* para ver los comandos disponibles.\n\n' +
                                 '💡 Comandos principales:\n' +
                                 '• *entrada* - Registrar ingreso\n' +
                                 '• *salida* - Registrar salida';
            }
        }

        // Enviar respuesta automática si hay una
        if (responseMessage) {
            try {
                await message.reply(responseMessage);
                
                // Guardar respuesta en base de datos
                await saveMessageLog(message.from, responseMessage, 'outgoing');
                
                // Notificar al frontend
                io.emit('message-sent', {
                    to: message.from,
                    body: responseMessage,
                    timestamp: new Date().toISOString()
                });
                
            } catch (error) {
                console.error('❌ Error enviando respuesta:', error.message);
            }
        }
    });

    // Inicializar cliente
    whatsappClient.initialize();
}

// Rutas de la API

// Obtener estado de WhatsApp
app.get('/api/whatsapp/status', async (req, res) => {
    try {
        const connection = await connectToDatabase();
        if (connection) {
            const [rows] = await connection.execute('SELECT * FROM whatsapp_status WHERE id = 1');
            await connection.end();
            
            res.json({
                success: true,
                data: {
                    connected: isWhatsAppConnected,
                    qrCode: currentQRCode,
                    lastConnected: rows[0]?.last_connected || null,
                    realTimeStatus: isWhatsAppConnected ? 'Conectado' : 'Desconectado'
                }
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Error conectando a base de datos'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Reconectar WhatsApp
app.post('/api/whatsapp/reconnect', async (req, res) => {
    try {
        console.log('🔄 Iniciando proceso de reconexión...');
        
        if (whatsappClient) {
            console.log('🔄 Destruyendo cliente anterior...');
            await whatsappClient.destroy();
        }
        
        // Limpiar estado
        isWhatsAppConnected = false;
        currentQRCode = null;
        
        // Notificar estado de reconexión
        io.emit('whatsapp-status', {
            connected: false,
            message: 'Reconectando WhatsApp...',
            loading: true
        });
        
        setTimeout(() => {
            console.log('🔄 Inicializando nuevo cliente...');
            initializeWhatsApp();
        }, 2000);
        
        res.json({
            success: true,
            message: 'Reconectando WhatsApp...'
        });
    } catch (error) {
        console.error('❌ Error reconectando:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Desconectar WhatsApp
app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        if (whatsappClient) {
            await whatsappClient.destroy();
            isWhatsAppConnected = false;
            currentQRCode = null;
            
            await updateWhatsAppStatus(false);
            
            io.emit('whatsapp-status', {
                connected: false,
                message: 'WhatsApp desconectado manualmente'
            });
        }
        
        res.json({
            success: true,
            message: 'WhatsApp desconectado'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Obtener logs de mensajes
app.get('/api/messages/logs', async (req, res) => {
    try {
        const limit = req.query.limit || 50;
        const connection = await connectToDatabase();
        
        if (connection) {
            const [rows] = await connection.execute(
                'SELECT * FROM message_logs ORDER BY timestamp DESC LIMIT ?',
                [parseInt(limit)]
            );
            await connection.end();
            
            res.json({
                success: true,
                data: rows
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Error conectando a base de datos'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Nueva ruta: Obtener registros de asistencia
app.get('/api/attendance/records', async (req, res) => {
    try {
        const limit = req.query.limit || 50;
        const connection = await connectToDatabase();
        
        if (connection) {
            const [rows] = await connection.execute(
                'SELECT * FROM attendance_records ORDER BY timestamp DESC LIMIT ?',
                [parseInt(limit)]
            );
            await connection.end();
            
            res.json({
                success: true,
                data: rows
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Error conectando a base de datos'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Backend funcionando correctamente',
        timestamp: new Date().toISOString(),
        whatsappConnected: isWhatsAppConnected
    });
});

// Manejar conexiones de WebSocket
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado via WebSocket:', socket.id);
    
    // Enviar estado actual al cliente que se conecta
    socket.emit('whatsapp-status', {
        connected: isWhatsAppConnected,
        message: isWhatsAppConnected ? 'WhatsApp conectado' : 'WhatsApp desconectado'
    });
    
    // Si hay un QR code disponible, enviarlo
    if (currentQRCode) {
        socket.emit('qr-code', {
            qrCode: currentQRCode,
            message: 'Escanea el código QR con WhatsApp'
        });
    }
    
    socket.on('disconnect', () => {
        console.log('🔌 Cliente desconectado:', socket.id);
    });
});

// Limpiar solicitudes pendientes cada 5 minutos
setInterval(() => {
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    
    for (const [phoneNumber, request] of pendingAttendanceRequests) {
        // Simplificado: eliminar todas las solicitudes cada 5 minutos
        // En producción, deberías guardar timestamp de cada solicitud
        if (Math.random() < 0.1) { // 10% de probabilidad de limpiar cada iteración
            pendingAttendanceRequests.delete(phoneNumber);
            console.log(`🧹 Solicitud pendiente limpiada para ${phoneNumber}`);
        }
    }
}, 5 * 60 * 1000); // Cada 5 minutos

// Inicializar WhatsApp al iniciar el servidor
setTimeout(() => {
    initializeWhatsApp();
}, 1000);

// Iniciar servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en puerto ${PORT}`);
    console.log(`📱 WhatsApp Integration: Iniciando...`);
    console.log(`🌐 CORS habilitado para: ${process.env.FRONTEND_URL || "http://localhost:5173"}`);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});