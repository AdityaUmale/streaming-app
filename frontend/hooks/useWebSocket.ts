'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type MessageHandler = (message: any) => void;
type MessageHandlers = Map<string, MessageHandler[]>;

export const useWebSocket = (url: string) => {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<MessageHandlers>(new Map());
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;

  const connect = useCallback(async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        console.log('🔗 Attempting to connect to:', url);
        wsRef.current = new WebSocket(url);
        
        wsRef.current.onopen = () => {
          console.log('🚀 WebSocket connected');
          setIsConnected(true);
          setConnectionError(null);
          reconnectAttemptsRef.current = 0;
          resolve();
        };

        wsRef.current.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            const { type } = message;
            const handlers = handlersRef.current.get(type) || [];
            handlers.forEach(handler => handler(message));
          } catch (error) {
            console.error('❌ Failed to parse message:', error);
          }
        };

        wsRef.current.onclose = (event) => {
          console.log('📡 WebSocket disconnected:', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean
          });
          setIsConnected(false);
          handleReconnect();
        };

        wsRef.current.onerror = (error) => {
          console.error('🔥 WebSocket error details:', {
            error,
            readyState: wsRef.current?.readyState,
            url: url,
            timestamp: new Date().toISOString()
          });
          setConnectionError(`Connection failed to ${url}`);
          reject(error);
        };
      } catch (error) {
        console.error('❌ Failed to create WebSocket:', error);
        setConnectionError('Failed to create WebSocket');
        reject(error);
      }
    });
  }, [url]);

  const handleReconnect = useCallback(() => {
    if (reconnectAttemptsRef.current < maxReconnectAttempts) {
      reconnectAttemptsRef.current++;
      const delay = 1000 * reconnectAttemptsRef.current;
      
      console.log(`🔄 Reconnecting... (${reconnectAttemptsRef.current}/${maxReconnectAttempts})`);
      
      setTimeout(() => {
        connect().catch(console.error);
      }, delay);
    } else {
      setConnectionError('Max reconnection attempts reached');
    }
  }, [connect]);

  const send = useCallback((message: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('⚠️ WebSocket not connected, message not sent');
    }
  }, []);

  const subscribe = useCallback((messageType: string, handler: MessageHandler) => {
    if (!handlersRef.current.has(messageType)) {
      handlersRef.current.set(messageType, []);
    }
    handlersRef.current.get(messageType)!.push(handler);

    // Return unsubscribe function
    return () => {
      const handlers = handlersRef.current.get(messageType);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) handlers.splice(index, 1);
      }
    };
  }, []);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    handlersRef.current.clear();
    setIsConnected(false);
  }, []);

  // Auto-connect on mount, cleanup on unmount
  useEffect(() => {
    connect().catch(console.error);
    return disconnect;
  }, [connect, disconnect]);

  return {
    isConnected,
    connectionError,
    send,
    subscribe,
    disconnect,
    reconnect: connect
  };
};