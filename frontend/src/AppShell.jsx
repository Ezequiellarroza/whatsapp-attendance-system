import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  AppBar, Toolbar, Typography, Tabs, Tab,
  Box, Chip, Container
} from '@mui/material';
import WhatsAppManager from './componentes/WhatsAppManager';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

// Stubs provisorios (reemplazá por tus componentes reales cuando quieras)
const Dashboard   = () => <Box p={2}><Typography variant="h6">Dashboard (provisorio)</Typography></Box>;
const Employees   = () => <Box p={2}><Typography variant="h6">Empleados (provisorio)</Typography></Box>;
const Offices     = () => <Box p={2}><Typography variant="h6">Oficinas (provisorio)</Typography></Box>;
const Attendances = () => <Box p={2}><Typography variant="h6">Asistencias (provisorio)</Typography></Box>;

// TabPanel que no desmonta (mantiene el socket vivo)
function TabPanel({ children, value, index }) {
  return (
    <Box role="tabpanel" hidden={value !== index} sx={{ display: value === index ? 'block' : 'none' }}>
      {children}
    </Box>
  );
}

export default function AppShell() {
  const [tab, setTab] = useState(0);
  const [systemStatus, setSystemStatus] = useState('loading'); // 'connected' | 'disconnected' | 'error' | 'loading'

  useEffect(() => {
    // Ping liviano al backend para el chip del header (independiente del socket)
    const fetchStatus = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/api/whatsapp/status`);
        const connected = !!res?.data?.data?.connected;
        setSystemStatus(connected ? 'connected' : 'disconnected');
      } catch {
        setSystemStatus('error');
      }
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 15000); // refresco suave
    return () => clearInterval(id);
  }, []);

  const chip = {
    connected:    { color: 'success', label: 'Sistema OK' },
    disconnected: { color: 'warning', label: 'WhatsApp desconectado' },
    error:        { color: 'error',   label: 'Sistema con errores' },
    loading:      { color: 'info',    label: 'Iniciando...' },
  }[systemStatus];

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Typography variant="h6">Sistema de Asistencia</Typography>
          <Chip color={chip.color} label={chip.label} />
        </Toolbar>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab label="Dashboard" />
          <Tab label="Empleados" />
          <Tab label="Oficinas" />
          <Tab label="Asistencias" />
          <Tab label="WhatsApp" />
        </Tabs>
      </AppBar>

      <Container maxWidth="xl" sx={{ py: 3 }}>
        <TabPanel value={tab} index={0}><Dashboard /></TabPanel>
        <TabPanel value={tab} index={1}><Employees /></TabPanel>
        <TabPanel value={tab} index={2}><Offices /></TabPanel>
        <TabPanel value={tab} index={3}><Attendances /></TabPanel>
        {/* Mantiene WhatsAppManager montado (socket activo) aunque cambies de tab */}
        <TabPanel value={tab} index={4}><WhatsAppManager /></TabPanel>
      </Container>
    </Box>
  );
}
