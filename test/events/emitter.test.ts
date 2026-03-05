import { describe, it, expect, vi } from 'vitest';
import { AzethEventEmitter } from '../../src/events/emitter.js';

describe('AzethEventEmitter', () => {
  describe('on / emit', () => {
    it('should call listener when event is emitted', async () => {
      const emitter = new AzethEventEmitter();
      const listener = vi.fn();

      emitter.on('afterPayment', listener);
      await emitter.emit('afterPayment', {
        url: 'https://example.com',
        method: 'GET',
        paymentMade: true,
        statusCode: 200,
        responseTimeMs: 150,
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://example.com',
        paymentMade: true,
      }));
    });

    it('should support multiple listeners on the same event', async () => {
      const emitter = new AzethEventEmitter();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on('afterPayment', listener1);
      emitter.on('afterPayment', listener2);
      await emitter.emit('afterPayment', {
        url: 'https://example.com',
        method: 'GET',
        paymentMade: false,
        statusCode: 200,
        responseTimeMs: 50,
      });

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('should not call listener after unsubscribe', async () => {
      const emitter = new AzethEventEmitter();
      const listener = vi.fn();

      const unsub = emitter.on('beforePayment', listener);
      unsub();

      await emitter.emit('beforePayment', { url: 'https://example.com', method: 'GET' });
      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle async listeners', async () => {
      const emitter = new AzethEventEmitter();
      const calls: number[] = [];

      emitter.on('afterPayment', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        calls.push(1);
      });
      emitter.on('afterPayment', async () => {
        calls.push(2);
      });

      await emitter.emit('afterPayment', {
        url: 'https://example.com',
        method: 'GET',
        paymentMade: true,
        statusCode: 200,
        responseTimeMs: 100,
      });

      expect(calls).toContain(1);
      expect(calls).toContain(2);
    });

    it('should swallow sync listener errors', async () => {
      const emitter = new AzethEventEmitter();
      const goodListener = vi.fn();

      emitter.on('beforePayment', () => { throw new Error('sync error'); });
      emitter.on('beforePayment', goodListener);

      await emitter.emit('beforePayment', { url: 'https://example.com', method: 'GET' });
      expect(goodListener).toHaveBeenCalledOnce();
    });

    it('should swallow async listener errors', async () => {
      const emitter = new AzethEventEmitter();
      const goodListener = vi.fn();

      emitter.on('afterPayment', async () => { throw new Error('async error'); });
      emitter.on('afterPayment', goodListener);

      await emitter.emit('afterPayment', {
        url: 'https://example.com',
        method: 'GET',
        paymentMade: true,
        statusCode: 200,
        responseTimeMs: 50,
      });

      expect(goodListener).toHaveBeenCalledOnce();
    });

    it('should do nothing when emitting event with no listeners', async () => {
      const emitter = new AzethEventEmitter();
      // Should not throw
      await emitter.emit('beforePayment', { url: 'https://example.com', method: 'GET' });
    });
  });

  describe('once', () => {
    it('should fire listener only once', async () => {
      const emitter = new AzethEventEmitter();
      const listener = vi.fn();

      emitter.once('beforeTransfer', listener);

      const data = { to: '0x1111111111111111111111111111111111111111' as `0x${string}`, amount: 100n };
      await emitter.emit('beforeTransfer', data);
      await emitter.emit('beforeTransfer', data);

      expect(listener).toHaveBeenCalledOnce();
    });

    it('should be unsubscribable before firing', async () => {
      const emitter = new AzethEventEmitter();
      const listener = vi.fn();

      const unsub = emitter.once('beforeTransfer', listener);
      unsub();

      await emitter.emit('beforeTransfer', {
        to: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        amount: 100n,
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners for a specific event', async () => {
      const emitter = new AzethEventEmitter();
      const paymentListener = vi.fn();
      const transferListener = vi.fn();

      emitter.on('afterPayment', paymentListener);
      emitter.on('beforeTransfer', transferListener);

      emitter.removeAllListeners('afterPayment');

      await emitter.emit('afterPayment', {
        url: 'https://example.com',
        method: 'GET',
        paymentMade: true,
        statusCode: 200,
        responseTimeMs: 50,
      });
      await emitter.emit('beforeTransfer', {
        to: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        amount: 100n,
      });

      expect(paymentListener).not.toHaveBeenCalled();
      expect(transferListener).toHaveBeenCalledOnce();
    });

    it('should remove all listeners when no event specified', async () => {
      const emitter = new AzethEventEmitter();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on('afterPayment', listener1);
      emitter.on('beforeTransfer', listener2);

      emitter.removeAllListeners();

      await emitter.emit('afterPayment', {
        url: 'https://example.com',
        method: 'GET',
        paymentMade: true,
        statusCode: 200,
        responseTimeMs: 50,
      });
      await emitter.emit('beforeTransfer', {
        to: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        amount: 100n,
      });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });
  });

  describe('listenerCount', () => {
    it('should return 0 for events with no listeners', () => {
      const emitter = new AzethEventEmitter();
      expect(emitter.listenerCount('afterPayment')).toBe(0);
    });

    it('should return correct count', () => {
      const emitter = new AzethEventEmitter();
      emitter.on('afterPayment', vi.fn());
      emitter.on('afterPayment', vi.fn());
      emitter.on('beforeTransfer', vi.fn());

      expect(emitter.listenerCount('afterPayment')).toBe(2);
      expect(emitter.listenerCount('beforeTransfer')).toBe(1);
    });

    it('should decrease after unsubscribe', () => {
      const emitter = new AzethEventEmitter();
      const unsub = emitter.on('afterPayment', vi.fn());

      expect(emitter.listenerCount('afterPayment')).toBe(1);
      unsub();
      expect(emitter.listenerCount('afterPayment')).toBe(0);
    });
  });

  describe('error events', () => {
    it('should emit paymentError with operation and error', async () => {
      const emitter = new AzethEventEmitter();
      const listener = vi.fn();

      emitter.on('paymentError', listener);
      await emitter.emit('paymentError', {
        operation: 'fetch402',
        error: new Error('payment failed'),
        context: { url: 'https://example.com' },
      });

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'fetch402',
        error: expect.any(Error),
      }));
    });

    it('should emit feedbackError independently of paymentError', async () => {
      const emitter = new AzethEventEmitter();
      const feedbackListener = vi.fn();
      const paymentListener = vi.fn();

      emitter.on('feedbackError', feedbackListener);
      emitter.on('paymentError', paymentListener);

      await emitter.emit('feedbackError', {
        operation: 'autoFeedback',
        error: new Error('feedback failed'),
      });

      expect(feedbackListener).toHaveBeenCalledOnce();
      expect(paymentListener).not.toHaveBeenCalled();
    });
  });
});
