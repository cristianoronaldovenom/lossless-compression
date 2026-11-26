`timescale 1ns/1ps
module tb_s10_dma_stream;
reg clk=0;always #5 clk=~clk;
reg reset=1,s_valid=0,s_last=0,m_ready=1;
reg [127:0] s_data=0;
reg [15:0] s_keep=16'hffff;
wire s_ready,m_valid,m_last,error;
wire [511:0] m_data;
wire [63:0] m_keep;
s10_dma_stream dut(.*);
integer i;
reg [79:0] expected;
initial begin
 repeat(3)@(negedge clk);reset=0;
 // Eight indices expand to ten output bytes, A=0, B=1023.
 for(i=0;i<8;i=i+1)expected[i*10+:10]=(i%2==0)?10'h3ff:10'h0;
 s_data[63:0]=64'h55;s_data[83:74]=10'h3ff;s_data[90:84]=7'd10;s_data[91]=1;
 s_last=1;s_valid=1;
 @(posedge clk);while(!s_ready)@(posedge clk);
 @(negedge clk);s_valid=0;
 wait(m_valid);if(m_keep!==64'h3ff||!m_last||m_data[79:0]!==expected||error)$fatal(1,"bad data");
 @(posedge clk);@(negedge clk);
 s_data[100]=1;s_valid=1;
 @(posedge clk);while(!s_ready)@(posedge clk);
 @(negedge clk);s_valid=0;
 if(!error||s_ready)$fatal(1,"bad record accepted");
 $display("PASS: DMA record framing");$finish;
end
initial begin #10000;$fatal(1,"timeout");end
endmodule
