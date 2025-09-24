import { useState, useEffect } from 'react';
import axios from 'axios';
import io from 'socket.io-client';
import {
  Container,
  Paper,
  Typography,
  Box,
  Card,
  CardContent,
  Button,
  Grid,
  Alert,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  CircularProgress
} from '@mui/material';
import {
  WhatsApp,
  QrCode,
  CheckCircle,
  Cancel,
  Refresh,
  Message,
  Send,
  GetApp
} from '@mui/icons-material';
import './App.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

function App() {
  // Estados principales
  const [whatsappStatus, setWhatsappStatus] = useState({
    connected: false,
    message: 'Iniciando...',
    loading: true
  });
  
  const [qrCode, setQrCode] = useState(null);
  const [messages, setMessages] = useState([]);
  const [systemStatus, setSystemStatus] = useState('loading');
  const [socket, setSocket] = useState(null);

  // Conectar WebSocket
  useEffect(() => {
    const newSocket = io(SOCKET_URL, {
      transports: ['websocket', 'polling']
    });
    
    setSocket(newSocket);
    
    // Escuchar eventos de WhatsApp
    newSocket.on('whatsapp-status', (data) => {
      console.log('📱 Estado WhatsApp actualizado:', data);
      setWhatsappStatus({
        connected: data.connected,
        message: data.message,
        error: data.error || false,
        loading: false
      });
      
      if (data.connected) {
        setQrCode(null);
        setSystemStatus('connected');
      } else {
        setSystemStatus('disconnected');
      }
    });
    
    // Escuchar QR Code
    newSocket.on('qr-code', (data) => {
      console.log('📱 QR Code recibido');
      setQrCode(data.qrCode);
      setWhatsappStatus(prev => ({
        ...prev,
        message: data.message,
        loading: false
      }));
    });
    
    // Escuchar mensajes recibidos
    newSocket.on('message-received', (data) => {
      console.log('📨 Mensaje recibido:', data);
      setMessages(prev => [{
        id: Date.now(),
        type: 'received',
        from: data.from,
        body: data.body,
        timestamp: data.timestamp,
        contact: data.contact
      }, ...prev.slice(0, 49)]); // Mantener solo 50 mensajes
    });
    
    // Escuchar mensajes enviados
    newSocket.on('message-sent', (data) => {
      console.log('📤 Mensaje enviado:', data);
      setMessages(prev => [{
        id: Date.now() + 1,
        type: 'sent',
        to: data.to,
        body: data.body,
        timestamp: data.timestamp
      }, ...prev.slice(0, 49)]);
    });
    
    // Cleanup
    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Obtener estado inicial
  useEffect(() => {
    fetchWhatsAppStatus();
    fetchRecentMessages();
  }, []);

  // Funciones API
  const fetchWhatsAppStatus = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/whatsapp/status`);
      if (response.data.success) {
        const data = response.data.data;
        setWhatsappStatus({
          connected: data.connected,
          message: data.realTimeStatus,
          loading: false
        });
        
        if (data.qrCode) {
          setQrCode(data.qrCode);
        }
        
        setSystemStatus(data.connected ? 'connected' : 'disconnected');
      }
    } catch (error) {
      console.error('Error obteniendo estado:', error);
      setSystemStatus('error');
      setWhatsappStatus({
        connected: false,
        message: 'Error de conexión con el servidor',
        loading: false,
        error: true
      });
    }
  };

  const fetchRecentMessages = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/messages/logs?limit=20`);
      if (response.data.success) {
        const formattedMessages = response.data.data.map(msg => ({
          id: msg.id,
          type: msg.message_type,
          from: msg.phone_number,
          body: msg.message_text,
          timestamp: msg.timestamp
        }));
        setMessages(formattedMessages);
      }
    } catch (error) {
      console.error('Error obteniendo mensajes:', error);
    }
  };

  const handleReconnect = async () => {
    try {
      setWhatsappStatus(prev => ({ ...prev, loading: true, message: 'Reconectando...' }));
      await axios.post(`${API_BASE_URL}/api/whatsapp/reconnect`);
    } catch (error) {
      console.error('Error reconectando:', error);
      setWhatsappStatus(prev => ({ 
        ...prev, 
        loading: false, 
        error: true,
        message: 'Error al reconectar'
      }));
    }
  };

  const handleDisconnect = async () => {
    try {
      await axios.post(`${API_BASE_URL}/api/whatsapp/disconnect`);
      setQrCode(null);
    } catch (error) {
      console.error('Error desconectando:', error);
    }
  };

  // Función para obtener el estado del sistema
  const getSystemStatusInfo = () => {
    switch (systemStatus) {
      case 'connected':
        return {
          color: 'success',
          icon: <CheckCircle />,
          text: 'Sistema Funcionando OK'
        };
      case 'disconnected':
        return {
          color: 'warning',
          icon: <Cancel />,
          text: 'WhatsApp Desconectado'
        };
      case 'error':
        return {
          color: 'error',
          icon: <Cancel />,
          text: 'Sistema con Errores'
        };
      default:
        return {
          color: 'info',
          icon: <CircularProgress size={20} />,
          text: 'Iniciando Sistema...'
        };
    }
  };

  const systemStatusInfo = getSystemStatusInfo();

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      {/* Header con estado del sistema */}
      <Paper elevation={3} sx={{ p: 3, mb: 4, bgcolor: 'background.paper' }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h4" component="h1" gutterBottom>
              🚀 Sistema de Asistencia WhatsApp
            </Typography>
            <Typography variant="subtitle1" color="text.secondary">
              Panel de Control y Monitoreo en Tiempo Real
            </Typography>
          </Box>
          
          <Chip
            icon={systemStatusInfo.icon}
            label={systemStatusInfo.text}
            color={systemStatusInfo.color}
            variant="filled"
            size="large"
            sx={{ fontSize: '1.1rem', px: 2, py: 1 }}
          />
        </Box>
      </Paper>

      <Grid container spacing={4}>
        {/* Panel de WhatsApp */}
        <Grid item xs={12} md={8}>
          <Card elevation={2}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={2}>
                <WhatsApp color="success" sx={{ mr: 1, fontSize: 30 }} />
                <Typography variant="h5" component="h2">
                  Estado de WhatsApp
                </Typography>
              </Box>
              
              <Divider sx={{ mb: 2 }} />
              
              {/* Estado de conexión */}
              <Box mb={3}>
                <Alert 
                  severity={whatsappStatus.connected ? 'success' : whatsappStatus.error ? 'error' : 'info'}
                  sx={{ mb: 2 }}
                >
                  <Typography variant="body1">
                    {whatsappStatus.loading && <CircularProgress size={20} sx={{ mr: 1 }} />}
                    {whatsappStatus.message}
                  </Typography>
                </Alert>
                
                <Box display="flex" gap={2}>
                  <Button
                    variant="contained"
                    startIcon={<Refresh />}
                    onClick={handleReconnect}
                    disabled={whatsappStatus.loading}
                    color="primary"
                  >
                    {whatsappStatus.loading ? 'Conectando...' : 'Reconectar'}
                  </Button>
                  
                  {whatsappStatus.connected && (
                    <Button
                      variant="outlined"
                      startIcon={<Cancel />}
                      onClick={handleDisconnect}
                      color="error"
                    >
                      Desconectar
                    </Button>
                  )}
                </Box>
              </Box>
              
              {/* QR Code */}
              {qrCode && (
                <Box textAlign="center" mt={3}>
                  <Typography variant="h6" gutterBottom>
                    📱 Escanea con WhatsApp
                  </Typography>
                  <Paper elevation={1} sx={{ p: 2, display: 'inline-block' }}>
                    <img
                      src={qrCode}
                      alt="QR Code WhatsApp"
                      style={{ width: '250px', height: '250px' }}
                    />
                  </Paper>
                  <Typography variant="body2" color="text.secondary" mt={1}>
                    Abre WhatsApp → Dispositivos Vinculados → Vincular dispositivo
                  </Typography>
                </Box>
              )}
              
              {/* Estado conectado */}
              {whatsappStatus.connected && (
                <Box textAlign="center" mt={3}>
                  <CheckCircle color="success" sx={{ fontSize: 80 }} />
                  <Typography variant="h6" color="success.main" mt={1}>
                    ✅ WhatsApp Conectado y Funcionando
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Listo para recibir comandos de asistencia
                  </Typography>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Panel de Mensajes en Tiempo Real */}
        <Grid item xs={12} md={4}>
          <Card elevation={2} sx={{ height: 'fit-content' }}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={2}>
                <Message color="primary" sx={{ mr: 1 }} />
                <Typography variant="h6" component="h3">
                  Mensajes en Tiempo Real
                </Typography>
              </Box>
              
              <Divider sx={{ mb: 2 }} />
              
              <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
                {messages.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" textAlign="center" py={4}>
                    No hay mensajes recientes
                  </Typography>
                ) : (
                  <List dense>
                    {messages.map((message) => (
                      <ListItem 
                        key={message.id}
                        sx={{ 
                          bgcolor: message.type === 'received' ? 'action.hover' : 'primary.light',
                          mb: 1,
                          borderRadius: 1,
                          border: '1px solid',
                          borderColor: message.type === 'received' ? 'divider' : 'primary.main'
                        }}
                      >
                        <ListItemIcon>
                          {message.type === 'received' ? <GetApp color="info" /> : <Send color="primary" />}
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            <Typography variant="caption" color="text.secondary">
                              {message.type === 'received' ? 'Recibido' : 'Enviado'} • {
                                new Date(message.timestamp).toLocaleTimeString()
                              }
                            </Typography>
                          }
                          secondary={
                            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                              {message.body}
                            </Typography>
                          }
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>
              
              {messages.length > 0 && (
                <Box textAlign="center" mt={2}>
                  <Button
                    size="small"
                    onClick={fetchRecentMessages}
                    startIcon={<Refresh />}
                  >
                    Actualizar
                  </Button>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Panel de Información */}
        <Grid item xs={12}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                📋 Comandos Disponibles para Testing
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={3}>
                  <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                    <Typography variant="h6" color="success.main">entrada</Typography>
                    <Typography variant="body2">Registrar entrada</Typography>
                  </Paper>
                </Grid>
                <Grid item xs={12} md={3}>
                  <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                    <Typography variant="h6" color="error.main">salida</Typography>
                    <Typography variant="body2">Registrar salida</Typography>
                  </Paper>
                </Grid>
                <Grid item xs={12} md={3}>
                  <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                    <Typography variant="h6" color="info.main">ayuda</Typography>
                    <Typography variant="body2">Ver comandos</Typography>
                  </Paper>
                </Grid>
                <Grid item xs={12} md={3}>
                  <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                    <Typography variant="h6" color="warning.main">estado</Typography>
                    <Typography variant="body2">Ver estado actual</Typography>
                  </Paper>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Container>
  );
}

export default App;