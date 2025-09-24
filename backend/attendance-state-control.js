// ==========================================
// SISTEMA DE CONTROL MEJORADO CON ID DE EMPLEADO
// Previene pérdida de estado y usa número de celular como ID
// ==========================================

// Cache persistente para estados actuales de empleados
const employeeStates = new Map();
const employeeSessions = new Map(); // Para mantener sesiones activas

// Configuración de control de estados
const STATE_CONTROL_CONFIG = {
    WORK_DAY_START: 6,              // 6:00 AM - inicio posible de jornada
    WORK_DAY_END: 22,               // 10:00 PM - fin posible de jornada
    MAX_WORK_HOURS: 12,             // Máximo 12 horas de trabajo continuo
    MISSING_EXIT_THRESHOLD: 2,       // 2 horas después del fin de jornada para detectar salida faltante
    MAX_ENTRIES_PER_DAY: 3,         // Máximo 3 entradas por día (considerando breaks)
    MIN_TIME_BETWEEN_ACTIONS: 5,    // Mínimo 5 minutos entre entrada/salida
    STATE_CACHE_DURATION: 60       // Duración del cache en minutos
};

/**
 * Extraer número de teléfono limpio desde WhatsApp ID
 */
function extractPhoneNumber(whatsappId) {
    // Formato: "5491123456789@c.us" -> "5491123456789"
    return whatsappId.replace('@c.us', '').replace('@s.whatsapp.net', '');
}

/**
 * Formatear número para mostrar
 */
function formatPhoneForDisplay(phoneNumber) {
    // Formato: "5491123456789" -> "+54 9 11 2345-6789"
    if (phoneNumber.length >= 10) {
        const countryCode = phoneNumber.substring(0, 2);
        const areaCode = phoneNumber.substring(2, 4);
        const number = phoneNumber.substring(4);
        return `+${countryCode} ${areaCode} ${number.substring(0, 4)}-${number.substring(4)}`;
    }
    return phoneNumber;
}

/**
 * Obtener o crear sesión de empleado
 */
function getOrCreateEmployeeSession(whatsappId) {
    const phoneNumber = extractPhoneNumber(whatsappId);
    
    if (!employeeSessions.has(phoneNumber)) {
        employeeSessions.set(phoneNumber, {
            phoneNumber: phoneNumber,
            whatsappId: whatsappId,
            displayPhone: formatPhoneForDisplay(phoneNumber),
            firstContact: new Date(),
            lastActivity: new Date(),
            messageCount: 0,
            pendingAction: null,
            pendingActionTime: null
        });
        
        console.log(`👤 Nueva sesión creada para empleado: ${formatPhoneForDisplay(phoneNumber)}`);
    } else {
        // Actualizar actividad
        const session = employeeSessions.get(phoneNumber);
        session.lastActivity = new Date();
        session.messageCount++;
    }
    
    return employeeSessions.get(phoneNumber);
}

/**
 * Obtener último registro de asistencia del empleado
 */
async function getLastAttendanceRecord(phoneNumber, date = null) {
    try {
        const connection = await connectToDatabase();
        if (connection) {
            let query = 'SELECT * FROM attendance_records WHERE phone_number LIKE ?';
            let params = [`%${phoneNumber}%`]; // Buscar por número contenido
            
            if (date) {
                query += ' AND DATE(timestamp) = DATE(?)';
                params.push(date);
            }
            
            query += ' ORDER BY timestamp DESC LIMIT 1';
            
            const [rows] = await connection.execute(query, params);
            await connection.end();
            
            return rows.length > 0 ? rows[0] : null;
        }
    } catch (error) {
        console.error('❌ Error obteniendo último registro:', error.message);
        return null;
    }
    return null;
}

/**
 * Obtener todos los registros del día actual del empleado
 */
async function getTodayAttendanceRecords(phoneNumber) {
    try {
        const connection = await connectToDatabase();
        if (connection) {
            const [rows] = await connection.execute(`
                SELECT * FROM attendance_records 
                WHERE phone_number LIKE ? AND DATE(timestamp) = CURDATE() 
                ORDER BY timestamp ASC
            `, [`%${phoneNumber}%`]);
            await connection.end();
            
            return rows;
        }
    } catch (error) {
        console.error('❌ Error obteniendo registros del día:', error.message);
        return [];
    }
    return [];
}

/**
 * DETERMINAR ESTADO ACTUAL DEL EMPLEADO (MEJORADO)
 */
async function getEmployeeCurrentState(whatsappId, forceRefresh = false) {
    const session = getOrCreateEmployeeSession(whatsappId);
    const phoneNumber = session.phoneNumber;
    
    // Verificar si tenemos estado en cache y es reciente
    const cacheKey = `state_${phoneNumber}`;
    const cached = employeeStates.get(cacheKey);
    
    if (!forceRefresh && cached && cached.cacheTime && 
        (Date.now() - cached.cacheTime) < (STATE_CONTROL_CONFIG.STATE_CACHE_DURATION * 60 * 1000)) {
        
        console.log(`📋 Usando estado en cache para ${session.displayPhone}`);
        return cached;
    }
    
    console.log(`🔄 Recalculando estado para empleado: ${session.displayPhone}`);
    
    const lastRecord = await getLastAttendanceRecord(phoneNumber);
    const todayRecords = await getTodayAttendanceRecords(phoneNumber);
    
    const currentTime = new Date();
    const currentHour = currentTime.getHours();
    
    // Contar entradas y salidas válidas del día
    const validEntries = todayRecords.filter(r => r.action_type === 'entrada' && r.validation_status === 'VALID');
    const validExits = todayRecords.filter(r => r.action_type === 'salida' && r.validation_status === 'VALID');
    
    const state = {
        phoneNumber: phoneNumber,
        whatsappId: whatsappId,
        displayPhone: session.displayPhone,
        currentStatus: 'OUT', // OUT, IN, UNKNOWN
        lastAction: null,
        lastActionTime: null,
        todayEntries: validEntries.length,
        todayExits: validExits.length,
        workingHours: 0,
        canEnter: false,
        canExit: false,
        warnings: [],
        missingExit: false,
        isWorkingHours: currentHour >= STATE_CONTROL_CONFIG.WORK_DAY_START && 
                       currentHour <= STATE_CONTROL_CONFIG.WORK_DAY_END,
        cacheTime: Date.now(),
        session: session
    };
    
    // Verificar si hay acción pendiente en la sesión
    if (session.pendingAction && session.pendingActionTime) {
        const pendingAge = (Date.now() - session.pendingActionTime) / (1000 * 60); // minutos
        
        if (pendingAge < 10) { // 10 minutos de validez para acciones pendientes
            state.pendingAction = session.pendingAction;
            state.warnings.push(`⏳ Acción pendiente: ${session.pendingAction} (${Math.round(pendingAge)} min)`);
        } else {
            // Limpiar acción pendiente expirada
            session.pendingAction = null;
            session.pendingActionTime = null;
        }
    }
    
    if (lastRecord && lastRecord.validation_status === 'VALID') {
        state.lastAction = lastRecord.action_type;
        state.lastActionTime = new Date(lastRecord.timestamp);
        
        // Calcular tiempo desde última acción
        const timeSinceLastAction = (currentTime - state.lastActionTime) / (1000 * 60); // minutos
        
        // Determinar estado actual basado en última acción
        if (state.lastAction === 'entrada') {
            state.currentStatus = 'IN';
            
            // Calcular horas trabajando
            state.workingHours = timeSinceLastAction / 60;
            
            // Detectar posible salida faltante
            if (currentHour > STATE_CONTROL_CONFIG.WORK_DAY_END && 
                timeSinceLastAction > (STATE_CONTROL_CONFIG.MISSING_EXIT_THRESHOLD * 60)) {
                state.missingExit = true;
                state.warnings.push(`⚠️ Posible salida faltante - Última entrada: ${state.lastActionTime.toLocaleTimeString('es-AR')}`);
            }
            
            // Detectar trabajo excesivo
            if (state.workingHours > STATE_CONTROL_CONFIG.MAX_WORK_HOURS) {
                state.warnings.push(`⚠️ Tiempo de trabajo excesivo: ${Math.round(state.workingHours)} horas`);
            }
            
        } else if (state.lastAction === 'salida') {
            state.currentStatus = 'OUT';
        }
        
        // Verificar tiempo mínimo entre acciones
        if (timeSinceLastAction < STATE_CONTROL_CONFIG.MIN_TIME_BETWEEN_ACTIONS) {
            state.warnings.push(`⏰ Menos de ${STATE_CONTROL_CONFIG.MIN_TIME_BETWEEN_ACTIONS} minutos desde última acción`);
        }
    }
    
    // Determinar qué acciones puede realizar
    state.canEnter = (state.currentStatus === 'OUT') && 
                    (validEntries.length < STATE_CONTROL_CONFIG.MAX_ENTRIES_PER_DAY) &&
                    state.isWorkingHours &&
                    !state.pendingAction; // No puede nueva acción si hay una pendiente
    
    state.canExit = (state.currentStatus === 'IN') && !state.pendingAction;
    
    // Guardar en cache
    employeeStates.set(cacheKey, state);
    
    console.log(`📊 Estado calculado para ${state.displayPhone}:`, {
        status: state.currentStatus,
        canEnter: state.canEnter,
        canExit: state.canExit,
        pendingAction: state.pendingAction,
        todayEntries: state.todayEntries,
        todayExits: state.todayExits
    });
    
    return state;
}

/**
 * MARCAR ACCIÓN COMO PENDIENTE
 */
function setPendingAction(whatsappId, action) {
    const session = getOrCreateEmployeeSession(whatsappId);
    session.pendingAction = action;
    session.pendingActionTime = Date.now();
    
    // También invalidar cache para forzar recalculo
    const phoneNumber = session.phoneNumber;
    employeeStates.delete(`state_${phoneNumber}`);
    
    console.log(`⏳ Acción pendiente marcada: ${action} para ${session.displayPhone}`);
}

/**
 * LIMPIAR ACCIÓN PENDIENTE
 */
function clearPendingAction(whatsappId) {
    const session = getOrCreateEmployeeSession(whatsappId);
    const hadPending = session.pendingAction;
    
    session.pendingAction = null;
    session.pendingActionTime = null;
    
    // Invalidar cache para forzar recalculo
    const phoneNumber = session.phoneNumber;
    employeeStates.delete(`state_${phoneNumber}`);
    
    if (hadPending) {
        console.log(`✅ Acción pendiente limpiada: ${hadPending} para ${session.displayPhone}`);
    }
    
    return hadPending;
}

/**
 * VALIDAR ACCIÓN DE ASISTENCIA (MEJORADO)
 */
async function validateAttendanceAction(whatsappId, requestedAction) {
    const employeeState = await getEmployeeCurrentState(whatsappId, true); // Forzar refresh
    
    console.log(`🔍 Validando acción "${requestedAction}" para ${employeeState.displayPhone}:`, {
        currentStatus: employeeState.currentStatus,
        lastAction: employeeState.lastAction,
        todayEntries: employeeState.todayEntries,
        todayExits: employeeState.todayExits,
        canEnter: employeeState.canEnter,
        canExit: employeeState.canExit,
        pendingAction: employeeState.pendingAction
    });
    
    const validation = {
        isAllowed: false,
        reason: '',
        employeeState: employeeState,
        suggestions: []
    };
    
    // Verificar si ya hay una acción pendiente diferente
    if (employeeState.pendingAction && employeeState.pendingAction !== requestedAction) {
        validation.reason = `⏳ Ya tienes una ${employeeState.pendingAction} pendiente. Completa esa acción primero o envía "cancelar".`;
        validation.suggestions.push(`Envía tu ubicación para completar ${employeeState.pendingAction}`);
        validation.suggestions.push('O envía "cancelar" para cancelar la acción pendiente');
        return validation;
    }
    
    if (requestedAction === 'entrada') {
        if (!employeeState.isWorkingHours) {
            validation.reason = `⏰ Fuera del horario laboral (${STATE_CONTROL_CONFIG.WORK_DAY_START}:00 - ${STATE_CONTROL_CONFIG.WORK_DAY_END}:00)`;
            validation.suggestions.push('Intenta registrar entrada durante el horario laboral');
            
        } else if (employeeState.currentStatus === 'IN') {
            const timeSinceEntry = ((new Date() - employeeState.lastActionTime) / (1000 * 60 * 60)).toFixed(1);
            validation.reason = `🚫 Ya tienes una entrada activa desde las ${employeeState.lastActionTime.toLocaleTimeString('es-AR')} (hace ${timeSinceEntry}h)`;
            validation.suggestions.push('Registra tu salida primero antes de una nueva entrada');
            validation.suggestions.push('Si olvidaste registrar salida ayer, contacta a tu supervisor');
            
        } else if (employeeState.todayEntries >= STATE_CONTROL_CONFIG.MAX_ENTRIES_PER_DAY) {
            validation.reason = `📊 Límite de entradas diarias alcanzado (${STATE_CONTROL_CONFIG.MAX_ENTRIES_PER_DAY})`;
            validation.suggestions.push('Contacta a tu supervisor si necesitas más entradas');
            
        } else if (employeeState.warnings.some(w => w.includes('minutos desde última acción'))) {
            validation.reason = `⏰ Debes esperar al menos ${STATE_CONTROL_CONFIG.MIN_TIME_BETWEEN_ACTIONS} minutos desde tu última acción`;
            validation.suggestions.push('Espera unos minutos e intenta nuevamente');
            
        } else {
            validation.isAllowed = true;
            validation.reason = '✅ Entrada permitida';
        }
        
    } else if (requestedAction === 'salida') {
        if (employeeState.currentStatus === 'OUT') {
            if (employeeState.todayExits === 0) {
                validation.reason = '🚫 No puedes registrar salida sin haber registrado entrada primero';
                validation.suggestions.push('Registra tu entrada primero');
            } else {
                validation.reason = `🚫 Ya registraste tu salida. Última salida: ${employeeState.lastActionTime.toLocaleTimeString('es-AR')}`;
                validation.suggestions.push('Si necesitas registrar una nueva entrada, hazlo primero');
            }
            
        } else if (employeeState.warnings.some(w => w.includes('minutos desde última acción'))) {
            validation.reason = `⏰ Debes esperar al menos ${STATE_CONTROL_CONFIG.MIN_TIME_BETWEEN_ACTIONS} minutos desde tu última acción`;
            validation.suggestions.push('Espera unos minutos e intenta nuevamente');
            
        } else {
            validation.isAllowed = true;
            validation.reason = '✅ Salida permitida';
            
            // Agregar información sobre tiempo trabajado
            if (employeeState.workingHours > 0) {
                validation.reason += ` (Tiempo trabajado: ${Math.round(employeeState.workingHours * 10) / 10}h)`;
            }
        }
    }
    
    return validation;
}

/**
 * Generar reporte de estado del empleado (MEJORADO)
 */
async function generateEmployeeStatusReport(whatsappId) {
    const state = await getEmployeeCurrentState(whatsappId, true);
    const todayRecords = await getTodayAttendanceRecords(state.phoneNumber);
    
    let report = '📊 *ESTADO ACTUAL DE ASISTENCIA*\n\n';
    
    // Información del empleado
    report += `👤 *Empleado:* ${state.displayPhone}\n`;
    
    // Estado actual
    const statusEmoji = state.currentStatus === 'IN' ? '🟢 DENTRO' : '🔴 FUERA';
    report += `📍 *Estado:* ${statusEmoji}\n`;
    
    if (state.lastAction) {
        report += `⏰ *Última acción:* ${state.lastAction.toUpperCase()} a las ${state.lastActionTime.toLocaleTimeString('es-AR')}\n`;
    }
    
    // Acción pendiente
    if (state.pendingAction) {
        report += `⏳ *Pendiente:* ${state.pendingAction.toUpperCase()} - esperando ubicación\n`;
    }
    
    // Estadísticas del día
    report += `\n📈 *HOY (${new Date().toLocaleDateString('es-AR')}):*\n`;
    report += `• Entradas registradas: ${state.todayEntries}\n`;
    report += `• Salidas registradas: ${state.todayExits}\n`;
    
    if (state.workingHours > 0) {
        report += `• Tiempo trabajando: ${Math.round(state.workingHours * 10) / 10} horas\n`;
    }
    
    // Acciones disponibles
    report += `\n🎯 *ACCIONES DISPONIBLES:*\n`;
    report += `• Entrada: ${state.canEnter ? '✅ Permitida' : '❌ No disponible'}\n`;
    report += `• Salida: ${state.canExit ? '✅ Permitida' : '❌ No disponible'}\n`;
    
    // Warnings
    if (state.warnings.length > 0) {
        report += `\n⚠️ *ADVERTENCIAS:*\n`;
        state.warnings.forEach(warning => {
            report += `• ${warning}\n`;
        });
    }
    
    // Historial del día
    if (todayRecords.length > 0) {
        report += `\n📝 *HISTORIAL DE HOY:*\n`;
        todayRecords.forEach((record, index) => {
            const emoji = record.action_type === 'entrada' ? '🟢' : '🔴';
            const status = record.validation_status === 'VALID' ? '✅' : '❌';
            const time = new Date(record.timestamp).toLocaleTimeString('es-AR');
            report += `${index + 1}. ${emoji} ${record.action_type.toUpperCase()} - ${time} ${status}\n`;
        });
    }
    
    return report;
}

/**
 * Crear mensaje de validación con información mejorada
 */
function formatStateValidationMessage(action, validation) {
    const actionEmoji = action === 'entrada' ? '🟢' : '🔴';
    const actionText = action === 'entrada' ? 'ENTRADA' : 'SALIDA';
    
    if (validation.isAllowed) {
        let message = `${actionEmoji} *${actionText} - Validación exitosa* ✅\n\n`;
        message += `👤 *Empleado:* ${validation.employeeState.displayPhone}\n`;
        message += `${validation.reason}\n\n`;
        
        if (validation.employeeState.warnings.length > 0) {
            message += `⚠️ *Advertencias:*\n`;
            validation.employeeState.warnings.forEach(warning => {
                if (!warning.includes('pendiente')) { // No mostrar warnings de pendientes aquí
                    message += `• ${warning}\n`;
                }
            });
            message += `\n`;
        }
        
        message += `📱 *AHORA comparte tu ubicación actual* para completar el registro.\n\n`;
        message += `📍 **IMPORTANTE:** Debes estar físicamente en el lugar de trabajo y usar "Ubicación actual" (NO buscar lugares).\n\n`;
        message += `⏰ Tienes 10 minutos para enviar tu ubicación.\n`;
        message += `❓ Responde "cancelar" si quieres cancelar.`;
        
        return message;
        
    } else {
        let message = `${actionEmoji} *${actionText} NO PERMITIDA* ❌\n\n`;
        message += `👤 *Empleado:* ${validation.employeeState.displayPhone}\n`;
        message += `*Razón:* ${validation.reason}\n\n`;
        
        if (validation.suggestions.length > 0) {
            message += `💡 *Soluciones:*\n`;
            validation.suggestions.forEach(suggestion => {
                message += `• ${suggestion}\n`;
            });
            message += `\n`;
        }
        
        // Agregar información del estado actual
        const state = validation.employeeState;
        message += `📊 *Tu estado actual:*\n`;
        message += `• Estado: ${state.currentStatus === 'IN' ? '🟢 DENTRO' : '🔴 FUERA'}\n`;
        message += `• Entradas hoy: ${state.todayEntries}/${STATE_CONTROL_CONFIG.MAX_ENTRIES_PER_DAY}\n`;
        message += `• Salidas hoy: ${state.todayExits}\n`;
        
        if (state.lastActionTime) {
            message += `• Última acción: ${state.lastAction} a las ${state.lastActionTime.toLocaleTimeString('es-AR')}\n`;
        }
        
        if (state.pendingAction) {
            message += `• Acción pendiente: ${state.pendingAction}\n`;
        }
        
        message += `\n📞 Si necesitas ayuda, contacta a tu supervisor.`;
        
        return message;
    }
}

// Exportar funciones mejoradas
module.exports = {
    extractPhoneNumber,
    formatPhoneForDisplay,
    getOrCreateEmployeeSession,
    getEmployeeCurrentState,
    validateAttendanceAction,
    generateEmployeeStatusReport,
    formatStateValidationMessage,
    setPendingAction,
    clearPendingAction,
    STATE_CONTROL_CONFIG,
    
    // Funciones de utilidad
    getAllEmployeeSessions: () => Array.from(employeeSessions.values()),
    clearEmployeeSession: (whatsappId) => {
        const phoneNumber = extractPhoneNumber(whatsappId);
        employeeSessions.delete(phoneNumber);
        employeeStates.delete(`state_${phoneNumber}`);
    },
    
    // Para debugging
    getEmployeeCache: (whatsappId) => {
        const phoneNumber = extractPhoneNumber(whatsappId);
        return {
            session: employeeSessions.get(phoneNumber),
            state: employeeStates.get(`state_${phoneNumber}`)
        };
    }
};