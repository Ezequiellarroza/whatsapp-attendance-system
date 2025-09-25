import { useEffect, useState } from 'react';
import axios from 'axios';
import io from 'socket.io-client';
import {
  Container, Paper, Typography, Box, Card, CardContent, Button,
  Grid, Alert, Chip, Divider, List, ListItem, ListItemText,
  ListItemIcon, CircularProgress
} from '@mui/material';
import {
  WhatsApp as WhatsAppIcon,
  QrCode as QrCodeIcon,
  CheckCircle, Cancel, Refresh, Message, Send, GetApp
} from '@mui/icons-material';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const SOCKET_URL   = import.meta.env.VITE_SOCKET_URL   || 'http://localhost:3001';

export default function WhatsAppManager() {
  const [whatsappStatus, setWhatsappStatus] = useState({ connected: false, message: 'Iniciando...', loading: true });
  const [qrCode, setQrCode] = useState(null);
  const [messages, setMessages] = useState([]);
  const [systemStatus, setSystemStatus] = useState('loading');

  // Socket
  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });

    socket.on('whatsapp-status', (data) => {
      setWhatsappStatus({ connected: data.connected, message: data.message, error: !!data.error, loading: false });
      setSystemStatus(data.connected ? 'connected' : 'disconnected');
      if (data.connected) setQrCode(null);
    });

    socket.on('qr-code', (data) => {
      setQrCode(data.qrCode);
      setWhatsappStatus(prev => ({ ...prev, message: data.message, loading: false }));
    });

    socket.on('message-received', (data) => {
      setMessages(prev => [{
        id: Date.now(), type: 'received', from: data.from, body: data.body, timestamp: data.timestamp, contact: data.contact
      }, ...prev.slice(0, 49)]);
    });

    socket.on('message-sent', (data) => {
      setMessages(prev => [{
        id: Date.now() + 1, type: 'sent', to: data.to, body: data.body, timestamp: data.timestamp
      }, ...prev.slice(0, 49)]);
    });

    return () => socket.disconnect();
  }, []);

  // Estado inicial + logs
  useEffect(() => {
    fetchStatus();
    fetchLogs();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/whatsapp/status`); // estado + QR
      if (res.data?.success) {
        const data = res.data.data;
        setWhatsappStatus({ connected: data.connected, message: data.realTimeStatus, loading: false });
        if (data.qrCode) setQrCode(data.qrCode);
        setSystemStatus(data.connected ? 'connected' : 'disconnected');
      }
    } catch (e) {
      setSystemStatus('error');
      setWhatsappStatus({ connected: false, message: 'Error de conexión con el servidor', loading: false, error: true });
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/messages/logs?limit=20`);
      if (res.data?.success) {
        const formatted = res.data.data.map(m => ({
          id: m.id, type: m.message_type, from: m.phone_number, body: m.message_text, timestamp: m.timestamp
        }));
        setMessages(formatted);
      }
    } catch { /* noop */ }
  };

  const handleReconnect = async () => {
    try {
      setWhatsappStatus(prev => ({ ...prev, loading: true, message: 'Reconectando...' }));
      await axios.post(`${API_BASE_URL}/api/whatsapp/reconnect`);
    } catch {
      setWhatsappStatus(prev => ({ ...prev, loading: false, error: true, message: 'Error al reconectar' }));
    }
  };

  const handleDisconnect = async () => {
    try {
      await axios.post(`${API_BASE_URL}/api/whatsapp/disconnect`);
      setQrCode(null);
    } catch { /* noop */ }
  };

  const system = (() => {
    switch (systemStatus) {
      case 'connected':    return { color: 'success', icon: <CheckCircle/>, text: 'Sistema Funcionando OK' };
      case 'disconnected': return { color: 'warning', icon: <Cancel/>,      text: 'WhatsApp Desconectado' };
      case 'error':        return { color: 'error',   icon: <Cancel/>,      text: 'Sistema con Errores' };
      default:             return { color: 'info',    icon: <CircularProgress size={20}/>, text: 'Iniciando Sistema...' };
    }
  })();

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      {/* Header */}
      <Paper elevation={3} sx={{ p: 3, mb: 4, bgcolor: 'background.paper' }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h4" gutterBottom>🚀 Sistema de Asistencia WhatsApp</Typography>
            <Typography variant="subtitle1" color="text.secondary">Panel de Control y Monitoreo en Tiempo Real</Typography>
          </Box>
          <Chip icon={system.icon} label={system.text} color={system.color} />
        </Box>
      </Paper>

      <Grid container spacing={4}>
        {/* Panel WhatsApp */}
        <Grid item xs={12} md={8}>
          <Card elevation={2}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={2}>
                <WhatsAppIcon color="success" sx={{ mr: 1, fontSize: 30 }} />
                <Typography variant="h5">Estado de WhatsApp</Typography>
              </Box>
              <Divider sx={{ mb: 2 }} />

              <Box mb={3}>
                <Alert severity={whatsappStatus.connected ? 'success' : whatsappStatus.error ? 'error' : 'info'} sx={{ mb: 2 }}>
                  <Typography variant="body1">
                    {whatsappStatus.loading && <CircularProgress size={20} sx={{ mr: 1 }} />}
                    {whatsappStatus.message}
                  </Typography>
                </Alert>

                <Box display="flex" gap={2}>
                  <Button variant="contained" startIcon={<Refresh />} onClick={handleReconnect} disabled={whatsappStatus.loading}>
                    {whatsappStatus.loading ? 'Conectando...' : 'Reconectar'}
                  </Button>
                  {whatsappStatus.connected && (
                    <Button variant="outlined" startIcon={<Cancel />} onClick={handleDisconnect} color="error">
                      Desconectar
                    </Button>
                  )}
                </Box>
              </Box>

              {/* QR */}
              {qrCode && (
                <Box textAlign="center" mt={3}>
                  <Typography variant="h6" gutterBottom>📱 Escanea con WhatsApp</Typography>
                  <Paper elevation={1} sx={{ p: 2, display: 'inline-block' }}>
                    <img src={qrCode} alt="QR Code WhatsApp" style={{ width: 250, height: 250 }} />
                  </Paper>
                  <Typography variant="body2" color="text.secondary" mt={1}>
                    Abre WhatsApp → Dispositivos Vinculados → Vincular dispositivo
                  </Typography>
                </Box>
              )}

              {/* Conectado */}
              {whatsappStatus.connected && (
                <Box textAlign="center" mt={3}>
                  <CheckCircle color="success" sx={{ fontSize: 80 }} />
                  <Typography variant="h6" color="success.main" mt={1}>✅ WhatsApp Conectado y Funcionando</Typography>
                  <Typography variant="body2" color="text.secondary">Listo para recibir comandos de asistencia</Typography>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Mensajes en tiempo real */}
        <Grid item xs={12} md={4}>
          <Card elevation={2} sx={{ height: 'fit-content' }}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={2}>
                <Message color="primary" sx={{ mr: 1 }} />
                <Typography variant="h6">Mensajes en Tiempo Real</Typography>
              </Box>
              <Divider sx={{ mb: 2 }} />

              <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
                {messages.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" textAlign="center" py={4}>No hay mensajes recientes</Typography>
                ) : (
                  <List dense>
                    {messages.map((m) => (
                      <ListItem key={m.id} sx={{
                        bgcolor: m.type === 'received' ? 'action.hover' : 'primary.light',
                        mb: 1, borderRadius: 1, border: '1px solid',
                        borderColor: m.type === 'received' ? 'divider' : 'primary.main'
                      }}>
                        <ListItemIcon>
                          {m.type === 'received' ? <GetApp color="info" /> : <Send color="primary" />}
                        </ListItemIcon>
                        <ListItemText
                          primary={<Typography variant="caption" color="text.secondary">
                            {m.type === 'received' ? 'Recibido' : 'Enviado'} • {new Date(m.timestamp).toLocaleTimeString()}
                          </Typography>}
                          secondary={<Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{m.body}</Typography>}
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>

              {messages.length > 0 && (
                <Box textAlign="center" mt={2}>
                  <Button size="small" onClick={fetchLogs} startIcon={<Refresh />}>Actualizar</Button>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Ayuda de comandos */}
        <Grid item xs={12}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>📋 Comandos Disponibles para Testing</Typography>
              <Grid container spacing={2}>
                {[
                  { label: 'entrada', color: 'success', desc: 'Registrar entrada' },
                  { label: 'salida',  color: 'error',   desc: 'Registrar salida' },
                  { label: 'ayuda',   color: 'info',    desc: 'Ver comandos' },
                  { label: 'estado',  color: 'warning', desc: 'Ver estado actual' },
                ].map(cmd => (
                  <Grid key={cmd.label} item xs={12} md={3}>
                    <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                      <Typography variant="h6" color={`${cmd.color}.main`}>{cmd.label}</Typography>
                      <Typography variant="body2">{cmd.desc}</Typography>
                    </Paper>
                  </Grid>
                ))}
              </Grid>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Container>
  );
}
