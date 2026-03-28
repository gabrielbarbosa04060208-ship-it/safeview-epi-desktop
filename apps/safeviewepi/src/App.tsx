// PATCH: src/App.tsx — V2
// Correção: BrowserRouter → HashRouter (obrigatório em qualquer protocolo sem servidor HTTP)
// app:// e file:// não têm servidor HTTP — HashRouter usa fragmento #/rota que funciona em ambos.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PPEConfigProvider } from "@/hooks/usePPEConfig";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <PPEConfigProvider>
        <Toaster />
        <Sonner />
        <HashRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </HashRouter>
      </PPEConfigProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
