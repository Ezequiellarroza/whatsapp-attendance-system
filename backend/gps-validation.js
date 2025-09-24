const mysql = require('mysql2/promise');

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

// ==========================================
// PUNTOS DE ACCESO Y CONFIGURACIÓN
// ==========================================

// Puntos de acceso autorizados
const AUTHORIZED_LOCATIONS = [
    {
        id: 1,
        name: 'Valle de los Ciervos',
        lat: -37.371644652229655,
        lng: -59.116792790280606,
        radius: 100 // metros
    },
    {
        id: 2,
        name: 'Refugio del Valle',
        lat: -37.37247355171709,
        lng: -59.11563111651744,
        radius: 100
    },
    {
        id: 3,
        name: 'Explora Tandil',
        lat: -37.33880343035198,
        lng: -59.131626087683635,
        radius: 100
    },
    {
        id: 4,
        name: 'Oficina de Desarrollo (Testing)',
        lat: -34.689821911341554,
        lng: -58.61410910531587,
        radius: 100
    }
];

// Configuración de validación básica
const GPS_CONFIG = {
    MAX_AGE_MINUTES: 2,           
    MIN_ACCURACY: 50,             
    MAX_RADIUS: 100,              
    MIN_TIME_BETWEEN_SAME_LOCATION: 30,
    SUSPICIOUS_PRECISION_THRESHOLD: 0.0000001
};

// ==========================================
// SISTEMA ANTI-FRAUDE AVANZADO
// ==========================================

// Cache para análisis de patrones por usuario
const userLocationHistory = new Map();
const suspiciousActivityLog = new Map();

// Configuración avanzada anti-fraude
const ADVANCED_FRAUD_CONFIG = {
    // Detección de coordenadas "perfectas"
    MAX_IDENTICAL_LOCATIONS: 3,           
    MIN_GPS_VARIATION: 0.00001,           
    SUSPICIOUS_PRECISION_DIGITS: 10,      
    
    // Análisis temporal
    MIN_TIME_BETWEEN_REQUESTS: 30,        
    MAX_SPEED_BETWEEN_LOCATIONS: 100,     
    
    // Metadata de WhatsApp
    EXPECTED_ACCURACY_RANGE: [5, 100],    
    SUSPICIOUS_ACCURACY_VALUES: [1, 2, 3], 
    
    // Patrones sospechosos
    MAX_WARNINGS_PER_USER: 5,             
    BLOCK_DURATION_MINUTES: 30            
};

// ==========================================
// FUNCIONES DE VALIDACIÓN BÁSICA
// ==========================================

/**
 * Calcular distancia entre dos coordenadas usando fórmula de Haversine
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Radio de la Tierra en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * 
        Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c * 1000; // Convertir a metros
    return Math.round(distance);
}

/**
 * Validar si la ubicación está dentro de un punto autorizado
 */
function isLocationAuthorized(userLat, userLng) {
    for (const location of AUTHORIZED_LOCATIONS) {
        const distance = calculateDistance(userLat, userLng, location.lat, location.lng);
        
        if (distance <= location.radius) {
            return {
                isValid: true,
                location: location,
                distance: distance,
                message: `Ubicación válida: ${location.name} (${distance}m del punto autorizado)`
            };
        }
    }
    
    // Encontrar la ubicación más cercana para el mensaje de error
    let closestLocation = null;
    let minDistance = Infinity;
    
    for (const location of AUTHORIZED_LOCATIONS) {
        const distance = calculateDistance(userLat, userLng, location.lat, location.lng);
        if (distance < minDistance) {
            minDistance = distance;
            closestLocation = location;
        }
    }
    
    return {
        isValid: false,
        distance: minDistance,
        closestLocation: closestLocation,
        message: `❌ Ubicación NO autorizada. Estás a ${minDistance}m de ${closestLocation.name}. Debes estar dentro de ${closestLocation.radius}m.`
    };
}

/**
 * Validar timestamp de la ubicación
 */
function isLocationTimestampValid(timestamp) {
    const now = Date.now();
    const locationTime = timestamp * 1000; // WhatsApp usa segundos
    const ageMinutes = (now - locationTime) / (1000 * 60);
    
    if (ageMinutes > GPS_CONFIG.MAX_AGE_MINUTES) {
        return {
            isValid: false,
            message: `❌ Ubicación demasiado antigua (${Math.round(ageMinutes)} minutos). Comparte tu ubicación actual.`
        };
    }
    
    return {
        isValid: true,
        age: Math.round(ageMinutes),
        message: `✅ Ubicación reciente (${Math.round(ageMinutes)} min)`
    };
}

/**
 * Validar precisión GPS
 */
function isLocationAccuracyValid(accuracy) {
    if (!accuracy || accuracy > GPS_CONFIG.MIN_ACCURACY) {
        return {
            isValid: false,
            message: `❌ Precisión GPS insuficiente (${accuracy || 'desconocida'}m). Necesitas precisión menor a ${GPS_CONFIG.MIN_ACCURACY}m. Intenta desde un lugar con mejor señal GPS.`
        };
    }
    
    return {
        isValid: true,
        message: `✅ Precisión GPS adecuada (${accuracy}m)`
    };
}

/**
 * FUNCIÓN BÁSICA DE VALIDACIÓN GPS
 */
async function validateGPSLocation(locationData, phoneNumber) {
    const {
        latitude: userLat,
        longitude: userLng,
        accuracy,
        timestamp
    } = locationData;
    
    console.log(`🔍 Validando ubicación básica de ${phoneNumber}:`, {
        lat: userLat,
        lng: userLng,
        accuracy,
        timestamp
    });
    
    const validationResults = {
        isValid: false,
        reasons: [],
        location: null,
        distance: null,
        warnings: []
    };
    
    // 1. Validar coordenadas básicas
    if (!userLat || !userLng) {
        validationResults.reasons.push('❌ Coordenadas GPS faltantes');
        return validationResults;
    }
    
    // 2. Validar timestamp
    if (timestamp) {
        const timestampValidation = isLocationTimestampValid(timestamp);
        if (!timestampValidation.isValid) {
            validationResults.reasons.push(timestampValidation.message);
            return validationResults;
        } else {
            validationResults.warnings.push(timestampValidation.message);
        }
    }
    
    // 3. Validar precisión GPS
    if (accuracy !== undefined) {
        const accuracyValidation = isLocationAccuracyValid(accuracy);
        if (!accuracyValidation.isValid) {
            validationResults.reasons.push(accuracyValidation.message);
            return validationResults;
        } else {
            validationResults.warnings.push(accuracyValidation.message);
        }
    }
    
    // 4. Validar autorización del lugar
    const locationValidation = isLocationAuthorized(userLat, userLng);
    if (!locationValidation.isValid) {
        validationResults.reasons.push(locationValidation.message);
        validationResults.distance = locationValidation.distance;
        validationResults.closestLocation = locationValidation.closestLocation;
        return validationResults;
    }
    
    // ✅ Todas las validaciones pasaron
    validationResults.isValid = true;
    validationResults.location = locationValidation.location;
    validationResults.distance = locationValidation.distance;
    validationResults.reasons.push(locationValidation.message);
    
    return validationResults;
}

// ==========================================
// FUNCIONES ANTI-FRAUDE AVANZADAS
// ==========================================

/**
 * Analizar historial de ubicaciones del usuario
 */
function analyzeLocationHistory(phoneNumber, currentLat, currentLng, timestamp) {
    if (!userLocationHistory.has(phoneNumber)) {
        userLocationHistory.set(phoneNumber, []);
    }
    
    const history = userLocationHistory.get(phoneNumber);
    const suspiciousFlags = [];
    
    // Agregar ubicación actual al historial
    history.push({
        lat: currentLat,
        lng: currentLng,
        timestamp: timestamp || Date.now(),
        accuracy: null
    });
    
    // Mantener solo últimas 10 ubicaciones
    if (history.length > 10) {
        history.shift();
    }
    
    // ANÁLISIS 1: Ubicaciones idénticas consecutivas
    if (history.length >= 2) {
        let identicalCount = 0;
        const lastLocation = history[history.length - 1];
        
        for (let i = history.length - 2; i >= 0; i--) {
            const prevLocation = history[i];
            if (lastLocation.lat === prevLocation.lat && 
                lastLocation.lng === prevLocation.lng) {
                identicalCount++;
            } else {
                break;
            }
        }
        
        if (identicalCount >= ADVANCED_FRAUD_CONFIG.MAX_IDENTICAL_LOCATIONS) {
            suspiciousFlags.push({
                type: 'IDENTICAL_LOCATIONS',
                severity: 'HIGH',
                message: `⚠️ ${identicalCount + 1} ubicaciones idénticas consecutivas detectadas`
            });
        }
    }
    
    // ANÁLISIS 2: Variación GPS demasiado baja
    if (history.length >= 3) {
        const recent = history.slice(-3);
        let totalVariation = 0;
        
        for (let i = 1; i < recent.length; i++) {
            const latDiff = Math.abs(recent[i].lat - recent[i-1].lat);
            const lngDiff = Math.abs(recent[i].lng - recent[i-1].lng);
            totalVariation += latDiff + lngDiff;
        }
        
        if (totalVariation < ADVANCED_FRAUD_CONFIG.MIN_GPS_VARIATION) {
            suspiciousFlags.push({
                type: 'LOW_GPS_VARIATION',
                severity: 'MEDIUM',
                message: '🔍 Variación GPS anormalmente baja (posible ubicación buscada)'
            });
        }
    }
    
    // ANÁLISIS 3: Velocidad humanamente imposible
    if (history.length >= 2) {
        const current = history[history.length - 1];
        const previous = history[history.length - 2];
        
        const distance = calculateDistance(
            previous.lat, previous.lng,
            current.lat, current.lng
        );
        
        const timeDiff = (current.timestamp - previous.timestamp) / 1000; // segundos
        const speedKmH = (distance / 1000) / (timeDiff / 3600);
        
        if (speedKmH > ADVANCED_FRAUD_CONFIG.MAX_SPEED_BETWEEN_LOCATIONS && distance > 1000) {
            suspiciousFlags.push({
                type: 'IMPOSSIBLE_SPEED',
                severity: 'HIGH',
                message: `🚗 Velocidad imposible: ${Math.round(speedKmH)} km/h entre ubicaciones`
            });
        }
    }
    
    return {
        history: history,
        suspiciousFlags: suspiciousFlags,
        riskLevel: suspiciousFlags.length > 0 ? 'HIGH' : 'LOW'
    };
}

/**
 * Detectar coordenadas "demasiado perfectas"
 */
function detectPerfectCoordinates(lat, lng) {
    const suspiciousFlags = [];
    
    // Convertir a string para analizar dígitos decimales
    const latStr = lat.toString();
    const lngStr = lng.toString();
    
    // ANÁLISIS 1: Demasiados ceros consecutivos
    const latZeros = (latStr.match(/0{3,}/g) || []).length;
    const lngZeros = (lngStr.match(/0{3,}/g) || []).length;
    
    if (latZeros > 0 || lngZeros > 0) {
        suspiciousFlags.push({
            type: 'PERFECT_COORDINATES',
            severity: 'HIGH',
            message: '🎯 Coordenadas con patrones sospechosos (demasiados ceros)'
        });
    }
    
    // ANÁLISIS 2: Precisión excesiva (más de 8 decimales es sospechoso)
    const latDecimals = (latStr.split('.')[1] || '').length;
    const lngDecimals = (lngStr.split('.')[1] || '').length;
    
    if (latDecimals > ADVANCED_FRAUD_CONFIG.SUSPICIOUS_PRECISION_DIGITS || 
        lngDecimals > ADVANCED_FRAUD_CONFIG.SUSPICIOUS_PRECISION_DIGITS) {
        suspiciousFlags.push({
            type: 'EXCESSIVE_PRECISION',
            severity: 'MEDIUM',
            message: '🔬 Precisión GPS anormalmente alta (posible coordenada buscada)'
        });
    }
    
    // ANÁLISIS 3: Coordenadas que terminan en .000000
    if (latStr.endsWith('.000000') || lngStr.endsWith('.000000')) {
        suspiciousFlags.push({
            type: 'ROUNDED_COORDINATES',
            severity: 'HIGH',
            message: '📍 Coordenadas redondeadas detectadas (ubicación buscada)'
        });
    }
    
    return suspiciousFlags;
}

/**
 * Validar metadata de precisión GPS
 */
function validateGPSMetadata(accuracy, timestamp) {
    const suspiciousFlags = [];
    
    // ANÁLISIS 1: Precisión sospechosamente perfecta
    if (accuracy && ADVANCED_FRAUD_CONFIG.SUSPICIOUS_ACCURACY_VALUES.includes(Math.floor(accuracy))) {
        suspiciousFlags.push({
            type: 'SUSPICIOUS_ACCURACY',
            severity: 'MEDIUM',
            message: `📡 Precisión GPS sospechosa: ${accuracy}m (valor poco común)`
        });
    }
    
    // ANÁLISIS 2: Sin timestamp (ubicación buscada no tiene timestamp real)
    if (!timestamp) {
        suspiciousFlags.push({
            type: 'MISSING_TIMESTAMP',
            severity: 'HIGH',
            message: '⏰ Falta timestamp GPS (posible ubicación buscada)'
        });
    }
    
    // ANÁLISIS 3: Precisión fuera de rango normal
    if (accuracy && (accuracy < ADVANCED_FRAUD_CONFIG.EXPECTED_ACCURACY_RANGE[0] || 
                     accuracy > ADVANCED_FRAUD_CONFIG.EXPECTED_ACCURACY_RANGE[1])) {
        suspiciousFlags.push({
            type: 'ABNORMAL_ACCURACY',
            severity: 'LOW',
            message: `📊 Precisión GPS fuera de rango normal: ${accuracy}m`
        });
    }
    
    return suspiciousFlags;
}

/**
 * Gestionar usuarios sospechosos
 */
function manageSuspiciousUser(phoneNumber, suspiciousFlags) {
    if (!suspiciousActivityLog.has(phoneNumber)) {
        suspiciousActivityLog.set(phoneNumber, {
            warnings: 0,
            lastWarning: null,
            isBlocked: false,
            blockUntil: null,
            incidents: []
        });
    }
    
    const userLog = suspiciousActivityLog.get(phoneNumber);
    
    // Verificar si el usuario está bloqueado
    if (userLog.isBlocked && userLog.blockUntil > Date.now()) {
        const remainingMinutes = Math.ceil((userLog.blockUntil - Date.now()) / (1000 * 60));
        return {
            isBlocked: true,
            message: `🚫 Usuario temporalmente bloqueado por actividad sospechosa. Tiempo restante: ${remainingMinutes} minutos.`
        };
    } else if (userLog.isBlocked && userLog.blockUntil <= Date.now()) {
        // Desbloquear usuario
        userLog.isBlocked = false;
        userLog.blockUntil = null;
        userLog.warnings = 0; // Reset warnings después del bloqueo
    }
    
    // Registrar incidentes actuales
    const highSeverityFlags = suspiciousFlags.filter(f => f.severity === 'HIGH');
    if (highSeverityFlags.length > 0) {
        userLog.warnings += highSeverityFlags.length;
        userLog.lastWarning = Date.now();
        userLog.incidents.push({
            timestamp: Date.now(),
            flags: suspiciousFlags
        });
        
        // Mantener solo últimos 20 incidentes
        if (userLog.incidents.length > 20) {
            userLog.incidents.shift();
        }
        
        // Bloquear si supera el límite de warnings
        if (userLog.warnings >= ADVANCED_FRAUD_CONFIG.MAX_WARNINGS_PER_USER) {
            userLog.isBlocked = true;
            userLog.blockUntil = Date.now() + (ADVANCED_FRAUD_CONFIG.BLOCK_DURATION_MINUTES * 60 * 1000);
            
            return {
                isBlocked: true,
                message: `🚫 Usuario bloqueado temporalmente por múltiples actividades sospechosas (${userLog.warnings} warnings). Duración: ${ADVANCED_FRAUD_CONFIG.BLOCK_DURATION_MINUTES} minutos.`
            };
        }
    }
    
    return {
        isBlocked: false,
        warnings: userLog.warnings,
        message: null
    };
}

/**
 * VALIDACIÓN GPS CON ANÁLISIS ANTI-FRAUDE AVANZADO
 */
async function validateGPSLocationAdvanced(locationData, phoneNumber) {
    const {
        latitude: userLat,
        longitude: userLng,
        accuracy,
        timestamp
    } = locationData;
    
    console.log(`🔍 VALIDACIÓN ANTI-FRAUDE AVANZADA para ${phoneNumber}:`, {
        lat: userLat,
        lng: userLng,
        accuracy,
        timestamp,
        hasTimestamp: !!timestamp
    });
    
    const validationResults = {
        isValid: false,
        reasons: [],
        warnings: [],
        suspiciousFlags: [],
        fraudRisk: 'LOW', // LOW, MEDIUM, HIGH, BLOCKED
        location: null,
        distance: null
    };
    
    // 1. Verificar si el usuario está bloqueado
    const userStatus = manageSuspiciousUser(phoneNumber, []);
    if (userStatus.isBlocked) {
        validationResults.fraudRisk = 'BLOCKED';
        validationResults.reasons.push(userStatus.message);
        return validationResults;
    }
    
    // 2. Validar coordenadas básicas
    if (!userLat || !userLng) {
        validationResults.reasons.push('❌ Coordenadas GPS faltantes');
        return validationResults;
    }
    
    // 3. ANÁLISIS ANTI-FRAUDE: Coordenadas perfectas
    const perfectCoordFlags = detectPerfectCoordinates(userLat, userLng);
    validationResults.suspiciousFlags.push(...perfectCoordFlags);
    
    // 4. ANÁLISIS ANTI-FRAUDE: Metadata GPS
    const metadataFlags = validateGPSMetadata(accuracy, timestamp);
    validationResults.suspiciousFlags.push(...metadataFlags);
    
    // 5. ANÁLISIS ANTI-FRAUDE: Historial de ubicaciones
    const historyAnalysis = analyzeLocationHistory(phoneNumber, userLat, userLng, timestamp);
    validationResults.suspiciousFlags.push(...historyAnalysis.suspiciousFlags);
    
    // 6. Evaluar nivel de riesgo de fraude
    const highRiskFlags = validationResults.suspiciousFlags.filter(f => f.severity === 'HIGH');
    const mediumRiskFlags = validationResults.suspiciousFlags.filter(f => f.severity === 'MEDIUM');
    
    if (highRiskFlags.length >= 2) {
        validationResults.fraudRisk = 'HIGH';
    } else if (highRiskFlags.length >= 1 || mediumRiskFlags.length >= 2) {
        validationResults.fraudRisk = 'MEDIUM';
    }
    
    // 7. Gestionar usuario sospechoso
    if (validationResults.fraudRisk === 'HIGH') {
        const userManagement = manageSuspiciousUser(phoneNumber, validationResults.suspiciousFlags);
        if (userManagement.isBlocked) {
            validationResults.fraudRisk = 'BLOCKED';
            validationResults.reasons.push(userManagement.message);
            return validationResults;
        }
    }
    
    // 8. Validación de ubicación original (si pasa filtros anti-fraude)
    const originalValidation = await validateGPSLocation(locationData, phoneNumber);
    
    // 9. Combinar resultados
    validationResults.isValid = originalValidation.isValid && (validationResults.fraudRisk !== 'HIGH' && validationResults.fraudRisk !== 'BLOCKED');
    validationResults.location = originalValidation.location;
    validationResults.distance = originalValidation.distance;
    validationResults.reasons.push(...originalValidation.reasons);
    validationResults.warnings.push(...originalValidation.warnings);
    
    // 10. Agregar warnings de fraude
    if (validationResults.suspiciousFlags.length > 0) {
        validationResults.warnings.push(`⚠️ Detectadas ${validationResults.suspiciousFlags.length} señales de actividad sospechosa`);
        
        // Log detallado para administradores
        console.log(`🚨 ACTIVIDAD SOSPECHOSA detectada para ${phoneNumber}:`, {
            riskLevel: validationResults.fraudRisk,
            flags: validationResults.suspiciousFlags.map(f => f.message),
            location: { lat: userLat, lng: userLng },
            approved: validationResults.isValid
        });
    }
    
    // 11. Rechazar si es alto riesgo de fraude
    if (validationResults.fraudRisk === 'HIGH' || validationResults.fraudRisk === 'BLOCKED') {
        validationResults.isValid = false;
        if (validationResults.fraudRisk === 'HIGH') {
            validationResults.reasons.push('🚨 Registro rechazado: Múltiples indicadores de ubicación fraudulenta detectados');
        }
    }
    
    return validationResults;
}

// ==========================================
// FUNCIONES DE GUARDADO Y RESPUESTA
// ==========================================

/**
 * Guardar registro de asistencia en base de datos
 */
async function saveAttendanceRecord(phoneNumber, action, locationData, validationResult) {
    try {
        const connection = await connectToDatabase();
        if (connection) {
            await connection.execute(`
                INSERT INTO attendance_records 
                (phone_number, action_type, latitude, longitude, location_name, 
                distance_from_point, validation_status, timestamp, accuracy, gps_timestamp) 
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
            `, [
                phoneNumber,
                action,
                locationData.latitude,
                locationData.longitude,
                validationResult.isValid ? validationResult.location.name : null,
                validationResult.distance,
                validationResult.isValid ? 'VALID' : 'INVALID',
                locationData.accuracy,
                locationData.timestamp ? new Date(locationData.timestamp * 1000) : null
            ]);
            
            await connection.end();
            console.log(`✅ Registro de asistencia guardado: ${phoneNumber} - ${action}`);
            
            return true;
        }
    } catch (error) {
        console.error('❌ Error guardando registro de asistencia:', error.message);
        return false;
    }
}

/**
 * Formatear mensaje de respuesta básica
 */
function formatValidationResponse(action, validationResult, phoneNumber) {
    const actionEmoji = action === 'entrada' ? '🟢' : '🔴';
    const actionText = action === 'entrada' ? 'ENTRADA' : 'SALIDA';
    
    if (validationResult.isValid) {
        let response = `${actionEmoji} *${actionText} REGISTRADA* ✅\n\n`;
        response += `📍 *Ubicación:* ${validationResult.location.name}\n`;
        response += `📏 *Distancia:* ${validationResult.distance}m del punto autorizado\n`;
        response += `🕐 *Hora:* ${new Date().toLocaleTimeString('es-AR')}\n`;
        response += `📅 *Fecha:* ${new Date().toLocaleDateString('es-AR')}\n\n`;
        response += `¡Registro exitoso! 🎉`;
        
        return response;
    } else {
        let response = `${actionEmoji} *${actionText} RECHAZADA* ❌\n\n`;
        response += `*Razones del rechazo:*\n`;
        
        validationResult.reasons.forEach((reason, index) => {
            response += `${index + 1}. ${reason}\n`;
        });
        
        response += `\n💡 *Soluciones:*\n`;
        response += `• Asegúrate de estar físicamente en el lugar de trabajo\n`;
        response += `• Activa el GPS con alta precisión\n`;
        response += `• Comparte tu ubicación actual (no guardada)\n`;
        response += `• Intenta desde un lugar con mejor señal GPS\n\n`;
        response += `📞 Contacta a tu supervisor si necesitas ayuda.`;
        
        return response;
    }
}

/**
 * Formatear respuesta con sistema anti-fraude
 */
function formatAdvancedValidationResponse(action, validationResult, phoneNumber) {
    const actionEmoji = action === 'entrada' ? '🟢' : '🔴';
    const actionText = action === 'entrada' ? 'ENTRADA' : 'SALIDA';
    
    if (validationResult.fraudRisk === 'BLOCKED') {
        return `${actionEmoji} *${actionText} BLOQUEADA* 🚫\n\n` +
               validationResult.reasons.join('\n') +
               '\n\n💡 *Para resolver este bloqueo:*\n' +
               '• Contacta a tu supervisor inmediatamente\n' +
               '• Proporciona explicación de tu ubicación\n' +
               '• El bloqueo se levantará automáticamente después del tiempo especificado';
    }
    
    if (validationResult.isValid) {
        let response = `${actionEmoji} *${actionText} REGISTRADA* ✅\n\n`;
        response += `📍 *Ubicación:* ${validationResult.location.name}\n`;
        response += `📏 *Distancia:* ${validationResult.distance}m del punto autorizado\n`;
        response += `🕐 *Hora:* ${new Date().toLocaleTimeString('es-AR')}\n`;
        response += `📅 *Fecha:* ${new Date().toLocaleDateString('es-AR')}\n`;
        
        // Agregar warnings si hay actividad sospechosa
        if (validationResult.fraudRisk === 'MEDIUM' || validationResult.fraudRisk === 'HIGH') {
            response += `\n⚠️ *ADVERTENCIA DE SEGURIDAD:*\n`;
            response += `Se detectaron patrones inusuales en tu ubicación.\n`;
            response += `Asegúrate de compartir siempre tu ubicación GPS actual real.\n`;
        }
        
        response += `\n¡Registro exitoso! 🎉`;
        return response;
    } else {
        let response = `${actionEmoji} *${actionText} RECHAZADA* ❌\n\n`;
        response += `*Razones del rechazo:*\n`;
        
        validationResult.reasons.forEach((reason, index) => {
            response += `${index + 1}. ${reason}\n`;
        });
        
        if (validationResult.fraudRisk === 'HIGH') {
            response += `\n🚨 *ALERTA DE SEGURIDAD:*\n`;
            response += `El sistema detectó múltiples indicadores de ubicación fraudulenta.\n`;
            response += `Asegúrate de estar físicamente en el lugar de trabajo y compartir tu ubicación GPS real actual.\n\n`;
        }
        
        response += `\n💡 *Soluciones:*\n`;
        response += `• Estar físicamente en el lugar de trabajo\n`;
        response += `• Usar "Ubicación actual" (NO buscar lugares)\n`;
        response += `• Activar GPS con alta precisión\n`;
        response += `• Contactar supervisor si el problema persiste\n\n`;
        response += `📞 Si crees que es un error, contacta a tu supervisor inmediatamente.`;
        
        return response;
    }
}

// Exportar todas las funciones
module.exports = {
    validateGPSLocation,
    validateGPSLocationAdvanced,
    saveAttendanceRecord,
    formatValidationResponse,
    formatAdvancedValidationResponse,
    AUTHORIZED_LOCATIONS,
    GPS_CONFIG,
    ADVANCED_FRAUD_CONFIG,
    // Funciones adicionales para debugging/admin
    getUserLocationHistory: (phoneNumber) => userLocationHistory.get(phoneNumber),
    getSuspiciousActivity: (phoneNumber) => suspiciousActivityLog.get(phoneNumber),
    clearUserWarnings: (phoneNumber) => {
        if (suspiciousActivityLog.has(phoneNumber)) {
            const log = suspiciousActivityLog.get(phoneNumber);
            log.warnings = 0;
            log.isBlocked = false;
            log.blockUntil = null;
        }
    }
};